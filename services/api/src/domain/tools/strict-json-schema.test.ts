import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertWithinStrictLimits,
  strictSchemaComplexity,
  toStrictJsonSchema,
} from './strict-json-schema.js';

describe('toStrictJsonSchema', () => {
  it('closes objects, requires every property and drops $schema', () => {
    const schema = toStrictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.boolean() }) }));
    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: {
          type: 'object',
          properties: { c: { type: 'boolean' } },
          required: ['c'],
          additionalProperties: false,
        },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('moves unsupported string, number and array constraints into the description', () => {
    const schema = toStrictJsonSchema(
      z.object({
        name: z.string().min(1).max(60),
        code: z.string().min(3),
        price: z.number().nonnegative(),
        tags: z.array(z.string()).min(1).max(3),
        pair: z.array(z.string()).min(2),
        big: z.int().min(0).max(1_000),
        any: z.int(),
      }),
    );
    expect(schema.properties).toEqual({
      name: { type: 'string', description: 'Non-empty. At most 60 characters.' },
      code: { type: 'string', description: 'At least 3 characters.' },
      price: { type: 'number', description: 'Minimum 0.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'At most 3 items.',
      },
      pair: { type: 'array', items: { type: 'string' }, description: 'At least 2 items.' },
      big: { type: 'integer', description: 'Minimum 0. Maximum 1000.' },
      any: { type: 'integer' },
    });
  });

  it('turns small integer ranges into enums, with null inside the enum when nullable', () => {
    const schema = toStrictJsonSchema(
      z.object({
        month: z.int().min(1).max(12),
        crowd: z.int().min(1).max(5).nullable(),
        level: z.enum(['low', 'high']).nullable(),
      }),
    );
    expect(schema.properties).toEqual({
      month: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      crowd: { enum: [1, 2, 3, 4, 5, null] },
      level: { enum: ['low', 'high', null] },
    });
    expect(strictSchemaComplexity(schema).unionParameters).toBe(0);
  });

  it('keeps other nullables as anyOf (one union each) and supported formats and patterns', () => {
    const schema = toStrictJsonSchema(
      z.object({
        id: z.string().max(10).nullable(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        at: z.iso.datetime(),
      }),
    );
    expect(schema.properties).toMatchObject({
      id: { anyOf: [{ type: 'string', description: 'At most 10 characters.' }, { type: 'null' }] },
      day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      at: { type: 'string', format: 'date-time' },
    });
    expect(strictSchemaComplexity(schema).unionParameters).toBe(1);
  });

  it('drops unsupported string formats', () => {
    const schema = toStrictJsonSchema(z.object({ site: z.url(), id: z.nanoid(), mail: z.email() }));
    expect(schema.properties).toMatchObject({
      site: { type: 'string', format: 'uri' },
      id: { type: 'string' },
      mail: { type: 'string', format: 'email' },
    });
    expect(
      (schema.properties as Record<string, Record<string, unknown>>).id?.format,
    ).toBeUndefined();
  });

  it('adds field descriptions by path, through nullable objects and arrays', () => {
    const schema = toStrictJsonSchema(
      z.object({
        outer: z.object({ list: z.array(z.object({ leaf: z.string().max(5) })) }).nullable(),
      }),
      { outer: 'Outer.', 'outer.list[].leaf': 'Leaf.' },
    );
    const outer = (schema.properties as Record<string, Record<string, unknown>>).outer;
    expect(outer?.description).toBe('Outer.');
    expect(JSON.stringify(schema)).toContain('"description":"Leaf. At most 5 characters."');
  });

  it('throws on an unknown description path and on non-object roots', () => {
    expect(() => toStrictJsonSchema(z.object({ a: z.string() }), { b: 'x' })).toThrow(
      /Unknown schema path/,
    );
    expect(() => toStrictJsonSchema(z.object({ a: z.string() }), { 'a[]': 'x' })).toThrow(
      /not an array/,
    );
    expect(() => toStrictJsonSchema(z.string())).toThrow(/object schema/);
  });

  it('returns a frozen schema', () => {
    expect(Object.isFrozen(toStrictJsonSchema(z.object({ a: z.string() })))).toBe(true);
  });
});

describe('strict mode limits', () => {
  it('counts unions and optional properties', () => {
    expect(
      strictSchemaComplexity({
        type: 'object',
        properties: {
          a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          b: { type: ['string', 'null'] },
        },
        required: ['a'],
      }),
    ).toEqual({ unionParameters: 2, optionalParameters: 1 });
  });

  it('rejects a tool set over the provider limits', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    const wide = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, union])),
      required: Array.from({ length: 17 }, (_, i) => `p${i}`),
    };
    expect(() => assertWithinStrictLimits([wide])).toThrow(/17 union-typed parameters/);
    expect(() =>
      assertWithinStrictLimits(Array.from({ length: 21 }, () => ({ type: 'object' }))),
    ).toThrow(/21 strict tools/);
    const optional = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`o${i}`, {}])),
    };
    expect(() => assertWithinStrictLimits([optional])).toThrow(/25 optional parameters/);
    expect(() => assertWithinStrictLimits([{ type: 'object' }])).not.toThrow();
  });
});
