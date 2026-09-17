/**
 * How a step's state is shown, as opposed to what it is.
 *
 * The workflow gates still run, a step that cannot start is still BLOCKED on
 * the server, the Progress Checklist still counts it as incomplete and the API
 * still refuses what it refused before. None of that changes here.
 *
 * What changes is that the word is not put in front of the user in red. A
 * coordinator opening an order at the start of its life met a wall of red
 * "Blocked" notices describing work nobody had reached yet, which reads as a
 * fault rather than as a sequence. A step that cannot start yet is shown as
 * what it also is — not started.
 *
 * One function, used everywhere a step state reaches the screen, so the two
 * screens that show the routine cannot drift apart.
 */

import type { StepState } from '@opsflow/shared';

export function displayStepState(state: StepState): StepState {
  return state === 'BLOCKED' ? ('NOT_STARTED' as StepState) : state;
}
