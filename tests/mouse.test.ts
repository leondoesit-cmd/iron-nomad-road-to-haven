import { describe, expect, it } from 'vitest';
import { InputManager } from '../src/input/input';

/** A window and document stand-in that records listeners so tests can fire DOM events. */
function fakeDom() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
  const canvas = { ownerDocument: doc, requestPointerLock: () => {} };
  return { win, doc, canvas };
}
const ev = (type: string, init: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), init);

function setup() {
  const { win, doc, canvas } = fakeDom();
  const im = new InputManager(win as unknown as Window);
  im.autoJoinKeyboard();
  im.attachMouse(canvas as unknown as HTMLElement);
  const lock = () => {
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  return { win, doc, im, lock };
}

describe('mouse look', () => {
  it('ignores the mouse until the pointer is captured', () => {
    const { win, im } = setup();
    win.dispatchEvent(ev('mousemove', { movementX: 50, movementY: 10 }));
    im.sample(1 / 60);
    expect(im.intents[0].mouse).toBe(false);
    expect(im.intents[0].lookDelta).toEqual([0, 0]);
  });

  it('turns captured movement into radians, right and up positive, and consumes it once', () => {
    const { win, im, lock } = setup();
    lock();
    win.dispatchEvent(ev('mousemove', { movementX: 100, movementY: -40 }));
    im.sample(1 / 60);
    const it = im.intents[0];
    expect(it.mouse).toBe(true);
    expect(it.lookDelta[0]).toBeCloseTo(100 * InputManager.MOUSE_RAD_PER_PX);
    expect(it.lookDelta[1]).toBeCloseTo(40 * InputManager.MOUSE_RAD_PER_PX);
    im.sample(1 / 60);
    expect(im.intents[0].lookDelta).toEqual([0, 0]);
  });

  it('exposes unconsumed movement for per-frame cameras and honours sensitivity', () => {
    const { win, im, lock } = setup();
    im.settings.mouseSens = 2;
    lock();
    win.dispatchEvent(ev('mousemove', { movementX: 10, movementY: 0 }));
    expect(im.pendingLook(0)[0]).toBeCloseTo(10 * InputManager.MOUSE_RAD_PER_PX * 2);
    expect(im.pendingLook(1)).toEqual([0, 0]);
  });

  it('left click fires and right click aims; releasing the pointer clears buttons', () => {
    const { win, doc, im, lock } = setup();
    lock();
    win.dispatchEvent(ev('mousedown', { button: 0 }));
    win.dispatchEvent(ev('mousedown', { button: 2 }));
    im.sample(1 / 60);
    expect(im.intents[0].rt).toBe(1);
    expect(im.intents[0].lt).toBe(1);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    im.sample(1 / 60);
    expect(im.intents[0].rt).toBe(0);
    expect(im.intents[0].lt).toBe(0);
  });

  it('drops the huge jump Chrome sometimes reports when the lock engages', () => {
    const { win, im, lock } = setup();
    lock();
    win.dispatchEvent(ev('mousemove', { movementX: 4000, movementY: 0 }));
    im.sample(1 / 60);
    expect(im.intents[0].lookDelta[0]).toBe(0);
  });

  it('pauses via the lost callback when the browser releases the pointer', () => {
    const { doc, im, lock } = setup();
    let lost = 0;
    im.onPointerLost = () => lost++;
    lock();
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(lost).toBe(1);
  });
});
