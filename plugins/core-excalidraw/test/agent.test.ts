import { describe, expect, it } from 'vitest';
import { applyDrawingOps, describeDrawing, layoutNotes } from '../src/agent';
import { emptyScene, newDrawing, parseDrawing, serializeDrawing } from '../src/format';

const live = (scene: ReturnType<typeof emptyScene>) => scene.elements.filter((e) => !e.isDeleted);
const byId = (scene: ReturnType<typeof emptyScene>, id: string) =>
  scene.elements.find((e) => e.id === id)!;

describe('drawings for agents', () => {
  it('adds labelled shapes and an arrow between them', () => {
    const scene = emptyScene();
    const out = applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, width: 160, height: 70, text: 'Client' },
      { op: 'add', type: 'ellipse', id: 'b', x: 400, y: 0, width: 160, height: 70, text: 'Server' },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b', text: 'asks' },
    ]);
    expect(out).toContain('added rectangle a');
    // Two shapes, their labels, the arrow and its label.
    expect(live(scene)).toHaveLength(6);
    const arrow = byId(scene, 'ab');
    expect(arrow.startBinding).toMatchObject({ elementId: 'a', mode: 'orbit' });
    expect(arrow.endBinding).toMatchObject({ elementId: 'b' });
    // From just right of the rectangle to just left of the ellipse, level.
    expect(arrow.x).toBeGreaterThan(160);
    expect(arrow.x).toBeLessThan(175);
    expect((arrow.points as number[][])[1]![0]! + (arrow.x as number)).toBeLessThan(400);
    expect((arrow.points as number[][])[1]![1]).toBeCloseTo(0);
    expect(byId(scene, 'a').boundElements).toEqual(
      expect.arrayContaining([{ id: 'ab', type: 'arrow' }]),
    );
    const label = live(scene).find((e) => e.containerId === 'a')!;
    expect(label.text).toBe('Client');
    // In the middle of its shape.
    expect((label.x as number) + (label.width as number) / 2).toBeCloseTo(80);
  });

  it('describes what is there, labels with what they label', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, text: 'Client', fill: '#ffc9c9' },
      { op: 'add', type: 'diamond', id: 'b', x: 300, y: 0, text: 'Ok?' },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b' },
      { op: 'add', type: 'text', id: 't', x: 0, y: 200, text: 'A note' },
    ]);
    const text = describeDrawing(scene);
    expect(text).toContain('4 elements');
    expect(text).toContain('[a] rectangle at (0, 0) size 160×70, label "Client", fill #ffc9c9');
    expect(text).toContain('[ab] arrow from a to b, through');
    expect(text).toContain('[t] text at (0, 200)');
    expect(text).not.toContain('Layout notes');
    expect(describeDrawing(emptyScene())).toBe('The drawing is empty.');
  });

  it('moves a label and the arrows with their shape', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, text: 'A' },
      { op: 'add', type: 'rectangle', id: 'b', x: 400, y: 0, text: 'B' },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b' },
    ]);
    const version = byId(scene, 'ab').version;
    applyDrawingOps(scene, [{ op: 'update', id: 'b', x: 400, y: 300 }]);
    const arrow = byId(scene, 'ab');
    const end = (arrow.points as number[][]).at(-1)!;
    // The arrow now goes down to the right, and ends at the left side of the box.
    expect(end[1]).toBeGreaterThan(100);
    expect((arrow.x as number) + end[0]!).toBeLessThan(400);
    expect((arrow.y as number) + end[1]!).toBeGreaterThan(300);
    expect(arrow.version).toBeGreaterThan(version);
    const label = live(scene).find((e) => e.containerId === 'b')!;
    expect(label.y as number).toBeGreaterThan(300);
  });

  it('grows a shape to hold its label, and changes or removes the label', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      {
        op: 'add',
        type: 'rectangle',
        id: 'a',
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        text: 'A long label here',
      },
    ]);
    expect(byId(scene, 'a').width as number).toBeGreaterThan(150);
    expect(layoutNotes(scene.elements)).toEqual([]);
    applyDrawingOps(scene, [{ op: 'update', id: 'a', text: 'Short' }]);
    expect(live(scene).find((e) => e.containerId === 'a')!.text).toBe('Short');
    applyDrawingOps(scene, [{ op: 'update', id: 'a', text: '' }]);
    expect(live(scene)).toHaveLength(1);
    expect(byId(scene, 'a').boundElements).toEqual([]);
  });

  it('deletes with what belongs to an element, and frees its arrows', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, text: 'A' },
      { op: 'add', type: 'rectangle', id: 'b', x: 400, y: 0 },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b' },
    ]);
    applyDrawingOps(scene, [{ op: 'delete', id: 'a' }]);
    expect(
      live(scene)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['ab', 'b']);
    expect(byId(scene, 'ab').startBinding).toBeNull();
    // Deleted elements stay in the file, marked: an open drawing merges the change by version.
    expect(byId(scene, 'a').isDeleted).toBe(true);
    applyDrawingOps(scene, [{ op: 'delete', id: 'ab' }]);
    expect(byId(scene, 'b').boundElements).toEqual([]);
  });

  it('says what overlaps', () => {
    const scene = emptyScene();
    const out = applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0 },
      { op: 'add', type: 'rectangle', id: 'b', x: 100, y: 30 },
      // A box around both is meant.
      { op: 'add', type: 'rectangle', id: 'around', x: -20, y: -20, width: 400, height: 200 },
    ]);
    expect(out).toContain('a and b overlap.');
    expect(out).not.toMatch(/around (and|overlap)|and around/);
  });

  it('refuses what cannot be done, without half of it', () => {
    const scene = emptyScene();
    expect(() => applyDrawingOps(scene, [{ op: 'update', id: 'nope', x: 1 }])).toThrow(
      /no element/,
    );
    expect(() => applyDrawingOps(scene, [{ op: 'add', type: 'star' }])).toThrow(/To add/);
    expect(() =>
      applyDrawingOps(scene, [{ op: 'add', type: 'arrow', from: 'x', to: 'y' }]),
    ).toThrow();
    applyDrawingOps(scene, [{ op: 'add', type: 'rectangle', id: 'a' }]);
    expect(() => applyDrawingOps(scene, [{ op: 'add', type: 'rectangle', id: 'a' }])).toThrow(
      /taken/,
    );
  });

  it('sets formulas in math mode', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'text', id: 'eq', x: 0, y: 0, text: 'Energy $E = mc^2$' },
      { op: 'add', type: 'rectangle', id: 'box', x: 0, y: 100, text: 'rate $\\gamma$' },
      { op: 'add', type: 'rectangle', id: 'price', x: 300, y: 100, text: 'Costs $5' },
      { op: 'add', type: 'text', id: 'two', x: 0, y: 300, text: '$5 and $6', math: false },
    ]);
    expect(byId(scene, 'eq')).toMatchObject({ subtype: 'math', customData: { useTex: true } });
    expect(live(scene).find((e) => e.containerId === 'box')!.subtype).toBe('math');
    expect(live(scene).find((e) => e.containerId === 'price')!.subtype).toBeUndefined();
    expect(byId(scene, 'two').subtype).toBeUndefined();
    expect(describeDrawing(scene)).toContain('text "Energy $E = mc^2$" (math)');
    // Plain again when the formula goes.
    applyDrawingOps(scene, [{ op: 'update', id: 'eq', text: 'Energy', math: false }]);
    expect(byId(scene, 'eq').subtype).toBeUndefined();
  });

  it('lays a flow out in steps, with arrows at right angles', () => {
    const scene = emptyScene();
    const out = applyDrawingOps(
      scene,
      [
        { op: 'add', type: 'rectangle', id: 'start', text: 'Start' },
        { op: 'add', type: 'diamond', id: 'ok', text: 'Valid?' },
        { op: 'add', type: 'rectangle', id: 'save', text: 'Save' },
        { op: 'add', type: 'rectangle', id: 'fix', text: 'Fix' },
        { op: 'add', type: 'rectangle', id: 'done', text: 'Done' },
        { op: 'add', type: 'arrow', id: 'a1', from: 'start', to: 'ok' },
        { op: 'add', type: 'arrow', id: 'a2', from: 'ok', to: 'save', text: 'yes' },
        { op: 'add', type: 'arrow', id: 'a3', from: 'ok', to: 'fix', text: 'no' },
        { op: 'add', type: 'arrow', id: 'a4', from: 'save', to: 'done' },
        { op: 'add', type: 'arrow', id: 'back', from: 'fix', to: 'ok' },
      ],
      undefined,
      { arrange: 'down' },
    );
    expect(out).toContain('arranged 5 elements as a flow down');
    expect(out).not.toContain('overlap');
    const y = (id: string) => byId(scene, id).y as number;
    const cx = (id: string) =>
      (byId(scene, id).x as number) + (byId(scene, id).width as number) / 2;
    // Four steps, one under the other; the two branches side by side.
    expect(y('start')).toBeLessThan(y('ok'));
    expect(y('ok')).toBeLessThan(y('save'));
    expect(y('save')).toBeCloseTo(y('fix'));
    expect(y('save')).toBeLessThan(y('done'));
    expect(cx('start')).toBeCloseTo(cx('ok'));
    expect(cx('save')).not.toBeCloseTo(cx('fix'));
    // Every segment of every arrow is level or upright.
    for (const arrow of live(scene).filter((e) => e.type === 'arrow')) {
      const points = arrow.points as number[][];
      expect(arrow.elbowed).toBe(true);
      for (let i = 1; i < points.length; i++) {
        const [dx, dy] = [points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!];
        expect(Math.min(Math.abs(dx), Math.abs(dy))).toBeCloseTo(0);
      }
    }
    // Straight down where one is under the other; the arrow back goes around.
    expect(byId(scene, 'a1').points).toHaveLength(2);
    expect(byId(scene, 'back').points).toHaveLength(4);
  });

  it('draws a straight arrow where one is asked for', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'ellipse', id: 'a', x: 0, y: 0 },
      { op: 'add', type: 'ellipse', id: 'b', x: 300, y: 250 },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b', route: 'straight' },
    ]);
    expect(byId(scene, 'ab').points).toHaveLength(2);
    expect(byId(scene, 'ab').elbowed).toBe(false);
  });

  it('says what is wrong with the layout beyond overlaps', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0 },
      { op: 'add', type: 'rectangle', id: 'b', x: 600, y: 0 },
      { op: 'add', type: 'rectangle', id: 'between', x: 300, y: 0 },
      { op: 'add', type: 'rectangle', id: 'c', x: 0, y: 300 },
      { op: 'add', type: 'rectangle', id: 'd', x: 600, y: 300 },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b', route: 'straight' },
      { op: 'add', type: 'arrow', id: 'ad', from: 'a', to: 'd', route: 'straight' },
      { op: 'add', type: 'arrow', id: 'bc', from: 'b', to: 'c', route: 'straight' },
      { op: 'add', type: 'rectangle', id: 'off', x: 8, y: 600 },
    ]);
    const notes = layoutNotes(scene.elements).join('\n');
    expect(notes).toContain('The arrow ab (a to b) goes through between.');
    expect(notes).toContain('ad (a to d) and bc (b to c) cross.');
    expect(notes).toMatch(/a and off are almost in one column \(8 apart\): align them\./);
    expect(notes).not.toContain('overlap');
  });

  it('finds uneven gaps, and evens them out', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0 },
      { op: 'add', type: 'rectangle', id: 'b', x: 200, y: 0 },
      { op: 'add', type: 'rectangle', id: 'c', x: 500, y: 0 },
    ]);
    expect(layoutNotes(scene.elements).join()).toContain(
      'The gaps in the row a, b, c are uneven (40, 140): distribute them.',
    );
    applyDrawingOps(scene, [{ op: 'distribute', ids: ['a', 'b', 'c'], direction: 'horizontal' }]);
    expect(byId(scene, 'a').x).toBe(0);
    expect(byId(scene, 'b').x).toBe(250);
    expect(byId(scene, 'c').x).toBe(500);
    expect(layoutNotes(scene.elements)).toEqual([]);
    applyDrawingOps(scene, [
      { op: 'distribute', ids: ['a', 'b', 'c'], direction: 'horizontal', gap: 60 },
    ]);
    expect(byId(scene, 'c').x).toBe(440);
  });

  it('aligns, with labels and arrows going along', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, text: 'A' },
      { op: 'add', type: 'rectangle', id: 'b', x: 30, y: 200, width: 220, text: 'B' },
      { op: 'add', type: 'arrow', id: 'ab', from: 'a', to: 'b' },
    ]);
    applyDrawingOps(scene, [{ op: 'align', ids: ['a', 'b'], align: 'center' }]);
    const cx = (id: string) =>
      (byId(scene, id).x as number) + (byId(scene, id).width as number) / 2;
    expect(cx('a')).toBeCloseTo(cx('b'));
    // One upright line now.
    expect(byId(scene, 'ab').points).toHaveLength(2);
    const label = live(scene).find((e) => e.containerId === 'a')!;
    expect((label.x as number) + (label.width as number) / 2).toBeCloseTo(cx('a'));
    applyDrawingOps(scene, [{ op: 'align', ids: ['a', 'b'], align: 'left' }]);
    expect(byId(scene, 'a').x).toBe(byId(scene, 'b').x);
    expect(() => applyDrawingOps(scene, [{ op: 'align', ids: ['a'], align: 'left' }])).toThrow(
      /at least 2/,
    );
  });

  it('groups, ungroups and orders', () => {
    const scene = emptyScene();
    applyDrawingOps(scene, [
      { op: 'add', type: 'rectangle', id: 'a', text: 'A' },
      { op: 'add', type: 'rectangle', id: 'b', x: 300 },
      { op: 'group', ids: ['a', 'b'] },
    ]);
    const group = (byId(scene, 'a').groupIds as string[])[0];
    expect(group).toBeTruthy();
    expect(byId(scene, 'b').groupIds).toEqual([group]);
    expect(live(scene).find((e) => e.containerId === 'a')!.groupIds).toEqual([group]);
    applyDrawingOps(scene, [{ op: 'ungroup', ids: ['a', 'b'] }]);
    expect(byId(scene, 'a').groupIds).toEqual([]);
    applyDrawingOps(scene, [{ op: 'order', ids: ['a'], position: 'front' }]);
    // The shape, then its label, behind everything else in the list.
    expect(scene.elements.slice(-2).map((e) => e.id)[0]).toBe('a');
    expect(scene.elements[0]!.id).toBe('b');
  });

  it('survives the file: written and read again', () => {
    const drawing = parseDrawing('d.excalidraw.md', newDrawing());
    applyDrawingOps(drawing.scene, [
      { op: 'add', type: 'rectangle', id: 'a', x: 0, y: 0, text: 'Kept' },
      {
        op: 'add',
        type: 'line',
        id: 'l',
        points: [
          [0, 100],
          [50, 150],
          [100, 100],
        ],
      },
    ]);
    const again = parseDrawing('d.excalidraw.md', serializeDrawing(drawing));
    expect(describeDrawing(again.scene)).toBe(describeDrawing(drawing.scene));
    expect(serializeDrawing(drawing)).toContain('Kept ^');
    expect(describeDrawing(again.scene)).toContain(
      '[l] line through (0, 100) (50, 150) (100, 100)',
    );
  });
});
