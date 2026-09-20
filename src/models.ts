/**
 * Model table of the KDK app.
 * COMMID is reported by the fan in its discovery reply.
 */
const MODELS_WITH_LIGHT = ['FM10GC', 'FM12GC', 'FM14GC', 'FM15GC'];
const MODELS_WITHOUT_LIGHT = ['FM12EC', 'FM14EC', 'FM15EC'];

/** Whether the model has a light, or undefined for a model the app does not know. */
export function modelHasLight(commId: string | undefined): boolean | undefined {
  const id = commId?.toUpperCase() ?? '';
  return MODELS_WITH_LIGHT.includes(id) ? true : MODELS_WITHOUT_LIGHT.includes(id) ? false : undefined;
}
