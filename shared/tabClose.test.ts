import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmTabClose, isCloseProtected } from './tabClose.ts';
import { createRecoveryQueue } from './recoveryQueue.ts';

type Tab = { id: string; name: string; dirty: boolean; recoveryDraft?: boolean; pinned?: boolean; content: string };
const draft = (overrides: Partial<Tab> = {}): Tab => ({ id: 'draft', name: 'untitled.txt', dirty: false, recoveryDraft: true, content: '', ...overrides });

test('recovered drafts require confirmation even when empty and not marked dirty', async () => {
  const tab = draft();
  let prompt = '';
  assert.equal(await confirmTabClose([tab], () => tab, (tab) => tab.dirty, async (message) => { prompt = message; return true; }), 'confirmed');
  assert.match(prompt, /untitled\.txt/);
  assert.match(prompt, /recovery copies will be discarded/);
  assert.match(prompt, /Saved files on disk will not be deleted/);
});

test('Cancel leaves the recovered text, binding and flags intact', async () => {
  const tab = draft({ content: 'My recovered work', pinned: true });
  const before = structuredClone(tab);
  assert.equal(await confirmTabClose([tab], () => tab, (tab) => tab.dirty, async () => false), 'cancelled');
  assert.deepEqual(tab, before);
});

test('normal pins remain protected but recovered pins can be confirmed closed', async () => {
  const normal = draft({ recoveryDraft: false, pinned: true });
  assert.equal(isCloseProtected(normal), true);
  assert.equal(await confirmTabClose([normal], () => normal, () => true, async () => assert.fail('Pinned tab must not prompt')), 'protected');
  const recovered = draft({ pinned: true });
  assert.equal(isCloseProtected(recovered), false);
  assert.equal(await confirmTabClose([recovered], () => recovered, () => false, async () => true), 'confirmed');
});

test('clean saved tabs close without a prompt; ordinary edits still prompt', async () => {
  const clean = draft({ recoveryDraft: false });
  assert.equal(await confirmTabClose([clean], () => clean, (tab) => tab.dirty, async () => assert.fail('Clean tab must not prompt')), 'confirmed');
  const edited = { ...clean, dirty: true };
  assert.equal(await confirmTabClose([edited], () => edited, (tab) => tab.dirty, async () => false), 'cancelled');
});

test('close-all and close-others prompt for recovered drafts in mixed selections', async () => {
  const recovered = draft();
  const saved = draft({ id: 'saved', recoveryDraft: false });
  const tabs = [saved, recovered];
  let prompts = 0;
  assert.equal(await confirmTabClose(tabs, (id) => tabs.find((tab) => tab.id === id), (tab) => tab.dirty, async (message) => {
    prompts++;
    assert.match(message, /Close 2 tabs/);
    return false;
  }), 'cancelled');
  assert.equal(prompts, 1);
  assert.equal(tabs.length, 2);
});

test('late edits or save results invalidate an open confirmation', async () => {
  const original = draft({ content: 'Before confirmation' });
  let current = original;
  const result = await confirmTabClose([original], () => current, () => true, async () => {
    current = { ...original, content: 'New work arrived during confirmation' };
    return true;
  });
  assert.equal(result, 'changed');
  assert.equal(current.content, 'New work arrived during confirmation');
});

test('a removed tab cannot be closed a second time by a late confirmation', async () => {
  const original = draft();
  assert.equal(await confirmTabClose([original], () => undefined, () => true, async () => true), 'changed');
});

test('confirmed removal checkpoints only surviving drafts after pending snapshots', async () => {
  const closed = draft();
  const kept = draft({ id: 'kept', content: 'Keep this work' });
  let tabs = [closed, kept];
  let checkpoint: Tab[] = [];
  const queue = createRecoveryQueue<Tab[]>(async (snapshot) => { checkpoint = snapshot; return 1; });
  const pending = queue.save(tabs);
  const decision = await confirmTabClose([closed], (id) => tabs.find((tab) => tab.id === id), () => true, async () => true);
  assert.equal(decision, 'confirmed');
  tabs = tabs.filter((tab) => tab !== closed);
  await queue.save(tabs);
  await pending;
  assert.deepEqual(checkpoint, [kept]);
});
