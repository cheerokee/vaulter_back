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
});
