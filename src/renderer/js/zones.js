import { $, el, toast, setChildren } from './util.js';
import { state, emit, on } from './state.js';
import { deleteAnnotation } from './annotations.js';
import { scrollToSpot, refreshAnnotations } from './viewer.js';

/**
 * The dead-zone list.
 *
 * Zones are easy to forget about — they're deliberately unobtrusive on the page
 * — and a forgotten one silently hides text from the reader and the AI. This
 * panel is the answer to "what have I actually marked?", with a thumbnail of
 * where each sits on its page.
 */

let selected = null;

export const allZones = () => state.annotations
  .filter((a) => a.type === 'deadzone')
  .sort((a, b) => a.page - b.page || a.y - b.y);

export function selectZone(id, { scroll = true } = {}) {
  selected = id;
  const zone = state.annotations.find((a) => a.id === id);
  refreshAnnotations();
  for (const node of document.querySelectorAll('.annoLayer .deadzone')) {
    node.classList.toggle('selected', node.dataset.id === id);
  }
  if (zone && scroll) scrollToSpot(zone.page, zone.y);
  render();
}

export function clearSelection() {
  selected = null;
  for (const node of document.querySelectorAll('.annoLayer .deadzone')) node.classList.remove('selected');
  render();
}

export const selectedZone = () => selected;

/** Remove the selected zone — what Backspace does while the tool is active. */
export function deleteSelected() {
  if (!selected) return false;
  deleteAnnotation(selected);
  selected = null;
  toast('Dead zone removed');
  return true;
}

function zoneCard(zone, i) {
  const thumb = el('div', { class: 'zone-thumb' },
    el('i', {
      style: {
        left: `${zone.x * 100}%`,
        top: `${zone.y * 100}%`,
        width: `${Math.max(6, zone.w * 100)}%`,
        height: `${Math.max(5, zone.h * 100)}%`
      }
    }));

  return el('div', {
    class: `zone-card${selected === zone.id ? ' selected' : ''}`,
    onclick: () => selectZone(zone.id)
  },
    thumb,
    el('div', { class: 'zone-info' },
      el('b', {}, `Page ${zone.page}`),
      el('small', {}, `${Math.round(zone.w * 100)}% × ${Math.round(zone.h * 100)}% of the page`)
    ),
    el('button', {
      class: 'zone-del',
      title: 'Remove this dead zone',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 7h12M9.5 7V5.5h5V7M7.5 7l.8 12.5h7.4L16.5 7"/></svg>',
      onclick: (e) => {
        e.stopPropagation();
        deleteAnnotation(zone.id);
        if (selected === zone.id) selected = null;
        toast('Dead zone removed');
      }
    })
  );
}

export function render() {
  const box = $('#zonesList');
  if (!box) return;
  const zones = allZones();

  if (!zones.length) {
    setChildren(box, el('p', { class: 'empty' },
      'None yet. Pick the Dead Zone tool and drag a box over a figure, caption or answer key — the reader will skip it and the AI won’t see it.'));
    return;
  }
  setChildren(box, ...zones.map(zoneCard));
}

export function initZones() {
  render();
  on('annotations:changed', render);

  // With the tool active, a selected zone can be deleted from the keyboard.
  document.addEventListener('keydown', (e) => {
    if (state.tool !== 'deadzone' || !selected) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    e.preventDefault();
    deleteSelected();
  });
}
