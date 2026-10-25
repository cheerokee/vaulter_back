import type { OpenAPIObject } from '@nestjs/swagger';
import { PUBLIC_API_TAG, filterPublicDocument } from './swagger.js';

function buildDoc(): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/v1/things': {
        get: {
          tags: [PUBLIC_API_TAG],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicDto' },
                },
              },
            },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['auth'],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretDto' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PublicDto: {
          type: 'object',
          properties: { nested: { $ref: '#/components/schemas/NestedDto' } },
        },
        NestedDto: { type: 'object', properties: {} },
        SecretDto: { type: 'object', properties: {} },
      },
    },
  };
}

describe('filterPublicDocument', () => {
  it('keeps only the public path', () => {
    const out = filterPublicDocument(buildDoc());
    expect(Object.keys(out.paths)).toEqual(['/v1/things']);
  });

  it('keeps only schemas reachable from public operations', () => {
    const out = filterPublicDocument(buildDoc());
    expect(Object.keys(out.components?.schemas ?? {}).sort()).toEqual([
      'NestedDto',
      'PublicDto',
    ]);
  });

  it('keeps nothing when no operation is public', () => {
    const doc = buildDoc();
    delete doc.paths['/v1/things'];
    const out = filterPublicDocument(doc);
    expect(out.paths).toEqual({});
    expect(out.components?.schemas ?? {}).toEqual({});
  });

  it('does not mutate the input', () => {
    const doc = buildDoc();
    filterPublicDocument(doc);
    expect(Object.keys(doc.paths)).toHaveLength(2);
  });

  it('keeps only the public operation of a mixed path', () => {
    const doc = buildDoc();
    doc.paths['/v1/things'] = {
      ...doc.paths['/v1/things'],
      post: { tags: ['internal'], responses: {} },
    };
    const out = filterPublicDocument(doc);
    expect(Object.keys(out.paths['/v1/things']!)).toEqual(['get']);
  });

  it('retains $ref inside array items', () => {
    const doc = buildDoc();
    doc.components!.schemas!.PublicDto = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { $ref: '#/components/schemas/ItemDto' },
        },
      },
    };
    doc.components!.schemas!.ItemDto = { type: 'object', properties: {} };
    const out = filterPublicDocument(doc);
    expect(Object.keys(out.components?.schemas ?? {}).sort()).toEqual([
      'ItemDto',
      'PublicDto',
    ]);
  });

  it('prunes securitySchemes, other component kinds, tags and security not used by kept operations', () => {
    const doc = buildDoc();
    doc.components!.securitySchemes = {
      bearer: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x' },
    };
    doc.components!.parameters = { P: { name: 'p', in: 'query' } };
    doc.paths['/auth/login']!.post!.security = [{ bearer: [] }];
    doc.tags = [{ name: PUBLIC_API_TAG }, { name: 'auth' }];
    doc.security = [{ bearer: [] }];
    const out = filterPublicDocument(doc);
    expect(out.components?.securitySchemes).toBeUndefined();
    expect(out.components?.parameters).toBeUndefined();
    expect(out.tags).toEqual([{ name: PUBLIC_API_TAG }]);
    expect(out.security).toBeUndefined();
  });

  it('keeps the securitySchemes referenced by kept operations', () => {
    const doc = buildDoc();
    doc.components!.securitySchemes = {
      apiKey: { type: 'apiKey', in: 'header', name: 'x' },
      bearer: { type: 'http', scheme: 'bearer' },
    };
    doc.paths['/v1/things']!.get!.security = [{ apiKey: [] }];
    const out = filterPublicDocument(doc);
    expect(Object.keys(out.components?.securitySchemes ?? {})).toEqual([
      'apiKey',
    ]);
  });

  it('keeps document-level security only when every kept operation needs it', () => {
    const doc = buildDoc();
    doc.components!.securitySchemes = {
      bearer: { type: 'http', scheme: 'bearer' },
    };
    doc.security = [{ bearer: [] }];
    doc.paths['/v1/things']!.get!.security = [{ bearer: [] }];
    expect(filterPublicDocument(doc).security).toEqual([{ bearer: [] }]);
    doc.paths['/v1/things']!.get!.security = undefined;
    expect(filterPublicDocument(doc).security).toBeUndefined();
  });
});
