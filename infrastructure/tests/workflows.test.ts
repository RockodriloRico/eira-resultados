import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const dir = new URL('../../.github/workflows/', import.meta.url);
const load = (name: string) => parse(readFileSync(new URL(name, dir), 'utf8'));
const deploy = load('deploy.yml');
const raw = readFileSync(new URL('deploy.yml', dir), 'utf8');

describe('workflow de despliegue sin capacidad efectiva (ADR-0013)', () => {
  it('solo se dispara a mano', () => {
    expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch']);
    expect(deploy.permissions).toEqual({ contents: 'read' });
  });

  it('guard exige autorización, confirmación, main y SMS real en prod', () => {
    const script = deploy.jobs.guard.steps[0].run as string;
    for (const text of [
      '"$ENABLED" = "true"',
      '"$CONFIRM" = "$STAGE"',
      'refs/heads/main',
      '"$PROD_SMS_READY" = "true"',
    ])
      expect(script).toContain(text);
    expect(deploy.jobs.guard.permissions).toBeUndefined();
  });

  it('solo plan y apply usan OIDC, tras guard, y en environments con aprobación', () => {
    for (const [id, job] of Object.entries<any>(deploy.jobs)) {
      const usesAws = JSON.stringify(job).includes('configure-aws-credentials');
      expect(job.permissions?.['id-token'] === 'write', id).toBe(usesAws);
      if (usesAws) expect(job.environment, id).toMatch(/^\$\{\{ inputs\.stage \}\}(-apply)?$/);
    }
    expect(deploy.jobs.build.needs).toBe('guard');
    expect(deploy.jobs.plan.needs).toBe('build');
    expect(deploy.jobs.apply.needs).toBe('plan');
    expect(deploy.jobs.plan.environment).not.toBe(deploy.jobs.apply.environment);
  });

  it('plan y apply comprueban rol y bucket en su environment antes de pedir credenciales', () => {
    for (const id of ['plan', 'apply']) {
      const steps = deploy.jobs[id].steps as { name?: string; uses?: string; run?: string }[];
      const check = steps.findIndex(
        (s) => s.run?.includes('-n "$ROLE"') && s.run.includes('-n "$BUCKET"'),
      );
      const creds = steps.findIndex((s) => s.uses?.includes('configure-aws-credentials'));
      expect(check, id).toBeGreaterThanOrEqual(0);
      expect(check, id).toBeLessThan(creds);
      // plan y apply usan roles distintos (uno por environment), comprobados por nombre.
      expect(steps[check]!.run, id).toContain(`*":role/eira-$STAGE-${id}")`);
    }
  });

  it('apply ejecuta solo el change set de este run y espera según su tipo', () => {
    const plan = JSON.stringify(deploy.jobs.plan);
    expect(plan).toContain('delete-change-set');
    expect(deploy.jobs.plan.outputs.changeset).toBe('${{ steps.changeset.outputs.id }}');
    const apply = JSON.stringify(deploy.jobs.apply);
    expect(apply).toContain('needs.plan.outputs.changeset');
    expect(apply).not.toContain('list-change-sets');
    expect(apply).toContain('stack-create-complete');
    expect(apply).toContain('ChangeSetType');
  });

  it('el plan no ejecuta el change set', () => {
    expect(JSON.stringify(deploy.jobs.plan)).toContain('--no-execute-changeset');
    expect(JSON.stringify(deploy.jobs.plan)).toContain('--role-arn \\"$CFN_ROLE\\"');
  });

  it('sin credenciales permanentes ni secretos de AWS', () => {
    expect(raw).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws-access-key-id|secrets\./);
    expect(raw).toContain('role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}');
  });

  it('todas las acciones de todos los workflows están fijadas a un SHA', () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const uses = [...readFileSync(new URL(file, dir), 'utf8').matchAll(/uses:\s*(\S+)/g)];
      for (const [, ref] of uses) expect(ref, file).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('CI no tiene id-token ni pasos de despliegue', () => {
    const ci = readFileSync(new URL('ci.yml', dir), 'utf8').replaceAll(/#.*$/gm, '');
    expect(ci).not.toMatch(/id-token|configure-aws-credentials|sam deploy|execute-change-set/);
  });
});
