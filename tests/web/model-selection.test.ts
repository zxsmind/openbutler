import { describe, expect, it } from 'vitest';
import { modelRouteKey, projectModelSelection } from '../../web/src/model-selection.js';

const models = [
  { providerId: 'first', modelId: 'model', name: 'Model' },
  { providerId: 'second', modelId: 'model', name: 'Other route' },
];
const runtime = {
  providerId: 'first',
  modelId: 'model',
  reasoningDefault: 'medium',
  reasoningVariants: [
    { id: 'low', label: 'Az' },
    { id: 'medium', label: 'Orta' },
    { id: 'high', label: 'High' },
  ],
};

describe('composer model capabilities', () => {
  it('keeps the published effort label, slider value and submitted value aligned', () => {
    const defaultView = projectModelSelection(runtime, models, null)!;
    expect(defaultView.reasoning).toMatchObject({ value: 'medium', label: 'Orta', canSelect: true, canReset: false });
    expect(projectModelSelection(runtime, models, 'high')!.reasoning).toMatchObject({ value: 'high', label: 'High', canReset: true });
    expect(projectModelSelection(runtime, models, 'stale-option')!.reasoning).toEqual(defaultView.reasoning);
  });
  it('distinguishes providers with the same model ID', () => {
    expect(modelRouteKey(models[0])).not.toBe(modelRouteKey(models[1]));
    expect(projectModelSelection(runtime, models, null)!.models.map((model) => model.selected)).toEqual([true, false]);
  });
  it('keeps fixed and unavailable reasoning passive without inventing options', () => {
    expect(projectModelSelection({ ...runtime, reasoningVariants: [] }, models, null)!.reasoning).toMatchObject({
      value: null,
      options: [],
      canSelect: false,
      canReset: false,
    });
    expect(projectModelSelection({ ...runtime, reasoningVariants: [runtime.reasoningVariants[0]] }, models, null)!.reasoning).toMatchObject(
      { value: 'low', canSelect: false },
    );
    expect(projectModelSelection(undefined, models, null)).toBeNull();
  });
});
