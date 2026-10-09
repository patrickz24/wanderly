import { Document, isScalar, visit } from 'yaml';

/**
 * Strings that YAML 1.1 parsers (PyYAML, js-yaml…) would read as dates, timestamps or booleans,
 * although YAML 1.2 (our `yaml` package) keeps them as strings.
 */
const YAML_11_AMBIGUOUS = /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ].*)?|y|n|yes|no|on|off)$/i;

/** Serialises data to YAML, quoting values that other parsers could mistype. No line folding. */
export function stringifyYaml(data: unknown): string {
  const document = new Document(data);
  visit(document, {
    Scalar(_key, node) {
      if (isScalar(node) && typeof node.value === 'string' && YAML_11_AMBIGUOUS.test(node.value)) {
        node.type = 'QUOTE_SINGLE';
      }
    },
  });
  return document.toString({ lineWidth: 0 });
}
