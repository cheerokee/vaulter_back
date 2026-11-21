import { Injectable } from '@nestjs/common';
import {
  AgentTurn,
  type AgentTurnView,
} from '../../../conversations/application/agent-turn.js';
import { HubConversationScope } from '../../../conversations/application/hub-conversation-scope.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import {
  assertToolResultSizes,
  brainStepLimit,
  cloudNotActive,
  cloudTermsAgentNotAccepted,
  type BrainStepRequest,
  type BrainStepResponse,
} from '../../domain/brain-step.js';
import { CloudTermAcceptanceRepository } from '../../domain/cloud.repositories.js';
import { BrainStepCounter } from './brain-step-counter.js';

/**
 * What the back does once every check passed (spec pc-agent §5.3, "O que o back faz"): reserve the budget, retrieve the
 * space's chunks, build the versioned prompt with the allowed tools, call the model once (plus the back-side document
 * tools) and settle. Out of any transaction; keeps nothing of the content. Implemented by Task 11; replaced by a fake
 * through DI in the e2e.
 *
 * Counting contract (`BrainStepCounter`, `BRAIN_MAX_CALLS` per message):
 * - the route already consumed ONE slot before calling `compose`: it pays for the step's first model call;
 * - the composer calls `consume(view)` only before each ADDITIONAL model call inside the same step (e.g. after running
 *   a back-side document tool), never before the first;
 * - `'limit'` mid-step: no further model call; the composer returns the last model text as `{ kind: 'final' }`;
 * - a step whose budget is refused (`{ kind: 'refused' }`) or whose composer fails still used its slot (documented and
 *   accepted: the slot bounds attempts, not successes).
 */
export abstract class BrainComposer {
  abstract compose(
    view: AgentTurnView,
    request: BrainStepRequest,
  ): Promise<BrainStepResponse>;
}

/** Default binding until Task 11 lands: the route answers 500 instead of pretending to think. */
@Injectable()
export class NotImplementedBrainComposer extends BrainComposer {
  compose(): Promise<BrainStepResponse> {
    return Promise.reject(new Error('The brain composer is not implemented'));
  }
}

/**
 * `POST /hub/conversations/:id/brain/step` (spec pc-agent §5.3). Checks, IN THIS ORDER and before any cost (the body
 * limit, 413, and the DTO's format check, 422, come before, in the HTTP layer):
 * 1. the hub (a `pc`: the route is `@PcHubOnly()`) executes the conversation in an organization with an approved link,
 *    else 404 `conversation-not-found` (`HubConversationScope`);
 * 2. the space is in `active_cloud` (else 422 `cloud-not-active`) and the organization accepted a term version that
 *    covers the agent (else 422 `cloud-terms-agent-not-accepted`);
 * 3. `messageId` is a person's message acked BY THIS HUB, its ack lease still running and not answered by it, else 409
 *    `brain-step-not-owned` (`AgentTurn.requireTurn`, which also re-checks 1);
 * 5. each tool result in `turns` at most 32 KiB of UTF-8, else 422 `validation-failed`. A pure check, run BEFORE the
 *    counter (controller ruling): a malformed request never uses a call slot; it keeps 404/422/409 ahead of it;
 * 4. fewer than `BRAIN_MAX_CALLS` model calls for the message: counted here (`BrainStepCounter.consume`, its own short
 *    transaction; a repeated `stepIndex` counts again), else 422 `brain-step-limit`. The LAST check: this slot is the
 *    step's first model call (see `BrainComposer` for the rest of the contract).
 * Then the composer (Task 11) and, after it returned, the renewal of the ack lease (a step keeps the turn: now + 15
 * min). A refused check renews nothing: the lease keeps running and the message goes back to the queue when it ends.
 * Nothing readable is logged or stored here.
 */
@Injectable()
export class BrainStepUseCase {
  constructor(
    private readonly scope: HubConversationScope,
    private readonly spaceCloud: SpaceCloud,
    private readonly acceptances: CloudTermAcceptanceRepository,
    private readonly turn: AgentTurn,
    private readonly counter: BrainStepCounter,
    private readonly composer: BrainComposer,
  ) {}

  async execute(
    hubId: string,
    conversationId: string,
    request: BrainStepRequest,
  ): Promise<BrainStepResponse> {
    const origin = await this.scope.organizationOf(hubId, conversationId);
    const mode = await this.spaceCloud.modeOf(
      origin.organizationId,
      origin.spaceId,
    );
    if (mode !== 'active_cloud') throw cloudNotActive();
    if (!(await this.acceptances.hasAgentCoverage(origin.organizationId))) {
      throw cloudTermsAgentNotAccepted();
    }
    const view = await this.turn.requireTurn(
      hubId,
      conversationId,
      request.messageId,
    );
    assertToolResultSizes(request.turns);
    if ((await this.counter.consume(view)) === 'limit') throw brainStepLimit();

    const response = await this.composer.compose(view, request);
    await this.turn.renewLease(hubId, conversationId, request.messageId);
    return response;
  }
}
