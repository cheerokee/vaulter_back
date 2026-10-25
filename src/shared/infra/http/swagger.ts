import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

// Só controllers com esta tag entram na documentação externa (integradores).
export const PUBLIC_API_TAG = 'public';

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = SCHEMA_REF.exec(value);
      if (match?.[1]) into.add(match[1]);
    } else {
      collectRefs(value, into);
    }
  }
}

export function filterPublicDocument(doc: OpenAPIObject): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      const isOperation = (HTTP_METHODS as readonly string[]).includes(key);
      if (!isOperation) {
        kept[key] = value; // parameters, summary, etc. do path
        continue;
      }
      const tags = (value as { tags?: string[] }).tags ?? [];
      if (tags.includes(PUBLIC_API_TAG)) kept[key] = value;
    }
    if (
      Object.keys(kept).some((k) =>
        (HTTP_METHODS as readonly string[]).includes(k),
      )
    ) {
      paths[path] = kept;
    }
  }

  // Busca transitiva: schemas alcançáveis por $ref a partir das operações mantidas.
  const allSchemas = doc.components?.schemas ?? {};
  const reached = new Set<string>();
  const queue = new Set<string>();
  collectRefs(paths, queue);
  while (queue.size > 0) {
    const [name] = queue;
    queue.delete(name!);
    if (reached.has(name!) || !(name! in allSchemas)) continue;
    reached.add(name!);
    collectRefs(allSchemas[name!], queue);
  }
  const schemas = Object.fromEntries(
    Object.entries(allSchemas).filter(([name]) => reached.has(name)),
  );

  return {
    ...doc,
    paths,
    components: { ...doc.components, schemas },
  };
}

export function setupSwagger(
  app: INestApplication,
  config: ConfigService,
): void {
  const title = config.getOrThrow<string>('API_DOCS_TITLE');
  const internalEnabled = [true, 'true'].includes(
    config.get<boolean | string>('API_DOCS_INTERNAL_ENABLED') ?? false,
  );

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(title)
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );

  // O público vem primeiro para '/docs/public' não ser capturado por '/docs'.
  SwaggerModule.setup('docs/public', app, filterPublicDocument(document), {
    jsonDocumentUrl: 'docs/public/json',
    yamlDocumentUrl: 'docs/public/yaml',
  });
  if (internalEnabled) {
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/json',
      yamlDocumentUrl: 'docs/yaml',
    });
  }
}
