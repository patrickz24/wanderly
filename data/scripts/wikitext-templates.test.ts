import { describe, expect, it } from 'vitest';
import {
  findTemplates,
  normaliseTemplateName,
  param,
  replaceTemplates,
  splitTopLevel,
} from './wikitext-templates.js';

describe('findTemplates', () => {
  it('finds top-level templates and keeps nested ones inside their parent', () => {
    const text = 'a {{see|name=X|content=near {{km|5}} town}} b {{IATA|PMO}}';
    const calls = findTemplates(text);
    expect(calls.map((call) => call.name)).toEqual(['see', 'iata']);
    expect(calls[0]?.raw).toBe('{{see|name=X|content=near {{km|5}} town}}');
    expect(text.slice(calls[1]?.start, calls[1]?.end)).toBe('{{IATA|PMO}}');
  });

  it('parses named and positional parameters, ignoring pipes inside links and templates', () => {
    const [call] = findTemplates(
      '{{marker|type=city|name=[[Syracuse (Italy)|Syracuse]]|{{lang|it|Siracusa}}|lat=37.07}}',
    );
    expect(call?.params.get('name')).toBe('[[Syracuse (Italy)|Syracuse]]');
    expect(call?.params.get('1')).toBe('{{lang|it|Siracusa}}');
    expect(call?.params.get('lat')).toBe('37.07');
  });

  it('handles multi-line templates with spaced keys and keeps "=" inside values', () => {
    const [call] = findTemplates('{{sleep\n| Name = Hotel A\n| price = rooms €50 = cheap\n}}');
    expect(call?.name).toBe('sleep');
    expect(param(call!, 'name')).toBe('Hotel A');
    expect(param(call!, 'price')).toBe('rooms €50 = cheap');
  });

  it('ignores an unterminated template', () => {
    expect(findTemplates('text {{see|name=X')).toEqual([]);
  });
});

describe('param', () => {
  it('returns the first non-blank value among the given keys', () => {
    const [call] = findTemplates('{{see|content=|description=Old field}}');
    expect(param(call!, 'content', 'description')).toBe('Old field');
    expect(param(call!, 'price')).toBeNull();
  });
});

describe('normaliseTemplateName', () => {
  it('lower-cases, trims and drops the Template: prefix, comments and underscores', () => {
    expect(normaliseTemplateName(' Template:Climate_chart <!-- x -->\n')).toBe('climate chart');
    expect(normaliseTemplateName('IsPartOf')).toBe('ispartof');
  });
});

describe('splitTopLevel / replaceTemplates', () => {
  it('splits only on top-level separators', () => {
    expect(splitTopLevel('a|[[b|c]]|{{d|e}}', '|')).toEqual(['a', '[[b|c]]', '{{d|e}}']);
  });

  it('replaces each top-level template with the rendered string', () => {
    expect(replaceTemplates('x {{a}} y {{b|{{c}}}} z', (call) => `<${call.name}>`)).toBe(
      'x <a> y <b> z',
    );
  });
});
