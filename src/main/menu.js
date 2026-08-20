'use strict';
const { Menu, app, shell } = require('electron');

module.exports = function buildMenu(getWin) {
  const send = (action) => () => {
    const win = getWin();
    if (win) win.webContents.send('menu', action);
  };

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'About You…', accelerator: 'Cmd+,', click: send('settings') },
        { label: 'Check for Updates…', click: send('checkUpdates') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'Cmd+O', click: send('open') },
        { label: 'Library', accelerator: 'Cmd+L', click: send('library') },
        { type: 'separator' },
        { label: 'Export Notes…', accelerator: 'Cmd+E', click: send('export') },
        { label: 'Reveal Notes File', click: send('reveal') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Document', accelerator: 'Cmd+F', click: send('find') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Thumbnails', accelerator: 'Cmd+1', click: send('panel:thumbnails') },
        { label: 'Outline', accelerator: 'Cmd+2', click: send('panel:outline') },
        { label: 'Notes', accelerator: 'Cmd+3', click: send('panel:notes') },
        { label: 'Ask AI', accelerator: 'Cmd+4', click: send('panel:ai') },
        { label: 'Document', accelerator: 'Cmd+5', click: send('document') },
        { type: 'separator' },
        { label: 'Read Aloud', accelerator: 'Cmd+R', click: send('read') },
        { label: 'Split View', accelerator: 'Cmd+Shift+S', click: send('split') },
        { label: 'Focus Video…', accelerator: 'Cmd+Shift+F', click: send('focus') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Cmd+Plus', click: send('zoom:in') },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: send('zoom:out') },
        { label: 'Fit Width', accelerator: 'Cmd+0', click: send('zoom:fit') },
        { type: 'separator' },
        { label: 'Toggle Day / Night', accelerator: 'Cmd+D', click: send('theme') },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Annotate',
      submenu: [
        { label: 'Highlight Tool', accelerator: 'Cmd+H', click: send('tool:highlight') },
        { label: 'Pin Note Tool', accelerator: 'Cmd+P', click: send('tool:pin') },
        { label: 'Dead Zone Tool', accelerator: 'Cmd+Shift+D', click: send('tool:deadzone') },
        { label: 'Select Tool', accelerator: 'Cmd+Escape', click: send('tool:select') }
      ]
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: [{
        label: 'Sludge on GitHub',
        click: () => shell.openExternal('https://github.com/Nickkk66/sludge')
      }]
    }
  ];

  return Menu.buildFromTemplate(template);
};
