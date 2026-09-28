import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Vitest's transform differs from the development server's tsx transform.
// Exercise the real development transform, then evaluate in a fresh JS scope.
describe('browser projection under tsx', () => {
  it('renders a completed turn without module-scoped compiler helpers', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { deriveTurns } from './src/ui/turnViewModel.ts';
      const project = new Function('return (' + deriveTurns.toString() + ')')();
      console.log(JSON.stringify(project([
        {type:'user', messageId:'m', text:'hello'},
        {type:'provisional', messageId:'m', text:'answer', finishReason:'stop'}
      ])));
    `], { encoding: 'utf8' });
    expect(JSON.parse(output)[0]).toMatchObject({ active: false, status: 'Complete', answers: [{ text: 'answer' }] });
  });
});
