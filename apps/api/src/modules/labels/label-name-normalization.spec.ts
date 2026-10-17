import {
  findLabelNameKeyCollisions,
  normalizeLabelNameKey,
  UNICODE_CASE_FOLD_VERSION,
} from './label-name-normalization';

describe('normalizeLabelNameKey', () => {
  it('uses the pinned Unicode case-fold table', () => {
    expect(UNICODE_CASE_FOLD_VERSION).toBe('16.0.0');
    expect(normalizeLabelNameKey('Straße')).toBe('strasse');
    expect(normalizeLabelNameKey('STRASSE')).toBe('strasse');
    expect(normalizeLabelNameKey('ﬃ')).toBe('ffi');
  });

  it('normalizes composed and decomposed names identically', () => {
    expect(normalizeLabelNameKey('École')).toBe('école');
    expect(normalizeLabelNameKey('E\u0301cole')).toBe('école');
  });

  it('folds non-ASCII case variants without locale dependence', () => {
    expect(normalizeLabelNameKey('Σίσυφος')).toBe('σίσυφοσ');
    expect(normalizeLabelNameKey('ΟΣ')).toBe('οσ');
    expect(normalizeLabelNameKey('Жёлтый')).toBe('жёлтый');
    expect(normalizeLabelNameKey('İ')).toBe(normalizeLabelNameKey('i\u0307'));
  });

  it('trims only the key input and is deterministic', () => {
    expect(normalizeLabelNameKey('  Straße  ')).toBe('strasse');
    expect(normalizeLabelNameKey('Straße')).toBe(
      normalizeLabelNameKey('straße'),
    );
  });
});

describe('findLabelNameKeyCollisions', () => {
  it('reports all legacy collisions with workspace and label ids', () => {
    const collisions = findLabelNameKeyCollisions([
      {
        workspaceId: 'workspace-a',
        id: 'label-a',
        name: 'Straße',
        nameKey: 'straße',
      },
      {
        workspaceId: 'workspace-a',
        id: 'label-b',
        name: 'STRASSE',
        nameKey: 'strasse',
      },
      {
        workspaceId: 'workspace-b',
        id: 'label-c',
        name: 'STRASSE',
        nameKey: 'strasse',
      },
    ]);

    expect(collisions).toEqual([
      {
        workspaceId: 'workspace-a',
        normalizedNameKey: 'strasse',
        labels: [
          {
            workspaceId: 'workspace-a',
            id: 'label-a',
            name: 'Straße',
            nameKey: 'straße',
          },
          {
            workspaceId: 'workspace-a',
            id: 'label-b',
            name: 'STRASSE',
            nameKey: 'strasse',
          },
        ],
      },
    ]);
  });
});
