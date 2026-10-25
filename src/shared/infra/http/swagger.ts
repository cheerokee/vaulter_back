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

  // Operações mantidas, para decidir tags e segurança.
  const operations = Object.values(paths).flatMap((item) =>
    Object.entries(item)
      .filter(([key]) => (HTTP_METHODS as readonly string[]).includes(key))
      .map(([, op]) => op as OperationInfo),
  );

  const usedTags = new Set(operations.flatMap((op) => op.tags ?? []));
  const keptDocSecurity =
    doc.security &&
    operations.length > 0 &&
    operations.every((op) => (op.security?.length ?? 0) > 0)
      ? doc.security
      : undefined;

  const usedSchemes = new Set<string>();
  for (const requirement of [
    ...operations.flatMap((op) => op.security ?? []),
    ...(keptDocSecurity ?? []),
  ]) {
    for (const name of Object.keys(requirement)) usedSchemes.add(name);
  }
  const securitySchemes = Object.fromEntries(
    Object.entries(doc.components?.securitySchemes ?? {}).filter(([name]) =>
      usedSchemes.has(name),
    ),
  );

  // Allowlist: só schemas alcançáveis e securitySchemes usados; o resto é descartado.
  const components: NonNullable<OpenAPIObject['components']> = {};
  if (Object.keys(schemas).length > 0) components.schemas = schemas;
  if (Object.keys(securitySchemes).length > 0) {
    components.securitySchemes = securitySchemes;
  }

  const { tags: _tags, security: _security, ...rest } = doc;
  const out: OpenAPIObject = { ...rest, paths, components };
  const tags = (doc.tags ?? []).filter((t) => usedTags.has(t.name));
  if (tags.length > 0) out.tags = tags;
  if (keptDocSecurity) out.security = keptDocSecurity;
  return out;
}

type OperationInfo = {
  tags?: string[];
  security?: Record<string, unknown>[];
};

export function setupSwagger(
  app: INestApplication,
  config: ConfigService,
): void {
  const title = config.getOrThrow<string>('API_DOCS_TITLE');
  const internalEnabled = [true, 'true'].includes(
    config.get<boolean | string>('API_DOCS_INTERNAL_ENABLED') ?? false,
  );

  const baseConfig = () =>
    new DocumentBuilder().setTitle(title).setVersion('1');
  // O esquema bearer só existe no documento interno.
  const publicDocument = filterPublicDocument(
    SwaggerModule.createDocument(app, baseConfig().build()),
  );

  // O público vem primeiro para '/docs/public' não ser capturado por '/docs'.
  SwaggerModule.setup('docs/public', app, publicDocument, {
    jsonDocumentUrl: 'docs/public/json',
    yamlDocumentUrl: 'docs/public/yaml',
  });
  if (internalEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      baseConfig().addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/json',
      yamlDocumentUrl: 'docs/yaml',
    });
  }
}
