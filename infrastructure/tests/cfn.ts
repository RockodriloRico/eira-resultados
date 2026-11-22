import { readFileSync } from 'node:fs';
import { parse, type ScalarTag, type CollectionTag } from 'yaml';

// Lector mínimo de plantillas CloudFormation/SAM para pruebas estáticas (sin AWS).
type Json = unknown;
export type Resource = {
  Type: string;
  Condition?: string;
  Properties?: Record<string, any>;
  Metadata?: Record<string, any>;
  DeletionPolicy?: string;
};
export type Template = {
  Parameters: Record<string, { AllowedValues?: string[]; Default?: string }>;
  Mappings: Record<string, Record<string, Record<string, Json>>>;
  Rules: Record<
    string,
    { RuleCondition?: Json; Assertions: { Assert: Json; AssertDescription: string }[] }
  >;
  Conditions: Record<string, Json>;
  Globals: { Function: Record<string, any> };
  Resources: Record<string, Resource>;
  Outputs: Record<string, { Value: Json; Condition?: string }>;
};

const INTRINSICS: Record<string, string> = {
  Ref: 'Ref',
  Condition: 'Condition',
  GetAtt: 'Fn::GetAtt',
  Sub: 'Fn::Sub',
  If: 'Fn::If',
  Equals: 'Fn::Equals',
  Not: 'Fn::Not',
  And: 'Fn::And',
  Or: 'Fn::Or',
  FindInMap: 'Fn::FindInMap',
  Join: 'Fn::Join',
  Select: 'Fn::Select',
  Split: 'Fn::Split',
  ImportValue: 'Fn::ImportValue',
  Base64: 'Fn::Base64',
  GetAZs: 'Fn::GetAZs',
  Cidr: 'Fn::Cidr',
};

const customTags: (ScalarTag | CollectionTag)[] = Object.entries(INTRINSICS).flatMap(
  ([short, long]) => {
    const tag = `!${short}`;
    const toKey = (value: unknown) => ({
      [long]: short === 'GetAtt' && typeof value === 'string' ? value.split('.') : value,
    });
    return [
      { tag, resolve: (value: string) => toKey(value) } as ScalarTag,
      { tag, collection: 'seq', resolve: (seq: any) => toKey(seq.toJSON()) } as CollectionTag,
      { tag, collection: 'map', resolve: (map: any) => toKey(map.toJSON()) } as CollectionTag,
    ];
  },
);

export const TEMPLATE_PATH = new URL('../template.yaml', import.meta.url);

export function loadTemplate(path: URL = TEMPLATE_PATH): Template {
  return parse(readFileSync(path, 'utf8'), { customTags }) as Template;
}

export type Params = Record<string, string>;

export function withDefaults(template: Template, params: Params): Params {
  const resolved: Params = {};
  for (const [name, def] of Object.entries(template.Parameters)) {
    const value = params[name] ?? def.Default;
    if (value === undefined) throw new Error(`Falta el parámetro ${name}`);
    if (def.AllowedValues && !def.AllowedValues.includes(value)) {
      throw new Error(`${name}=${value} no está en AllowedValues`);
    }
    resolved[name] = value;
  }
  return resolved;
}

// Evalúa expresiones booleanas de Conditions y Rules con valores concretos de parámetros.
export function evaluate(template: Template, expr: Json, params: Params): Json {
  if (typeof expr !== 'object' || expr === null) return expr;
  if (Array.isArray(expr)) return expr.map((item) => evaluate(template, item, params));
  const [key, arg] = Object.entries(expr as Record<string, Json>)[0]!;
  switch (key) {
    case 'Ref': {
      const value = params[arg as string];
      if (value === undefined) throw new Error(`Ref no resoluble: ${String(arg)}`);
      return value;
    }
    case 'Condition':
      return evaluate(template, template.Conditions[arg as string], params);
    case 'Fn::Equals': {
      const [a, b] = evaluate(template, arg, params) as Json[];
      return String(a) === String(b);
    }
    case 'Fn::Not':
      return !(evaluate(template, (arg as Json[])[0], params) as boolean);
    case 'Fn::And':
      return (arg as Json[]).every((item) => evaluate(template, item, params) === true);
    case 'Fn::Or':
      return (arg as Json[]).some((item) => evaluate(template, item, params) === true);
    case 'Fn::If': {
      const [cond, whenTrue, whenFalse] = arg as [string, Json, Json];
      const chosen = evaluate(template, template.Conditions[cond], params) === true;
      return evaluate(template, chosen ? whenTrue : whenFalse, params);
    }
    case 'Fn::FindInMap': {
      const [map, top, second] = evaluate(template, arg, params) as string[];
      return template.Mappings[map!]![top!]![second!];
    }
    default:
      throw new Error(`Intrínseca no soportada por el evaluador: ${key}`);
  }
}

export function condition(template: Template, name: string, params: Params): boolean {
  return evaluate(template, template.Conditions[name], withDefaults(template, params)) === true;
}

// Devuelve las descripciones de las aserciones de Rules que fallarían en CloudFormation.
export function failedRules(template: Template, params: Params): string[] {
  const resolved = withDefaults(template, params);
  const failures: string[] = [];
  for (const rule of Object.values(template.Rules)) {
    if (
      rule.RuleCondition !== undefined &&
      evaluate(template, rule.RuleCondition, resolved) !== true
    ) {
      continue;
    }
    for (const assertion of rule.Assertions) {
      if (evaluate(template, assertion.Assert, resolved) !== true) {
        failures.push(assertion.AssertDescription);
      }
    }
  }
  return failures;
}

export function resourcesOfType(template: Template, type: string): [string, Resource][] {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

// Sustituye ${Stage} en nombres definidos con !Sub para crear tablas locales.
export function subStage(value: Json, stage: string): Json {
  if (typeof value === 'string') return value;
  const sub = (value as { 'Fn::Sub'?: string })['Fn::Sub'];
  if (typeof sub === 'string') return sub.replaceAll('${Stage}', stage);
  throw new Error(`Valor no resoluble localmente: ${JSON.stringify(value)}`);
}

export function statementsOf(role: Resource): any[] {
  return (role.Properties?.Policies ?? []).flatMap(
    (policy: any) => policy.PolicyDocument.Statement as any[],
  );
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
