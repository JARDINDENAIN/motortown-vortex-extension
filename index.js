/* Motor Town Vortex 2.0.2 — modules regroupes, sources non minifiees. */
'use strict';
const __mtModules = {
"lib/archive.js": function(module, exports, require, __dirname) {
'use strict';

const path = require('path').win32;
const PAKS = 'MotorTown\\Content\\Paks';
const BIN = 'MotorTown\\Binaries\\Win64';
const PAK_TYPE = 'motortown-pak';
const ROOT_TYPE = 'motortown-root';
const CONTAINERS = new Set(['.pak', '.utoc', '.ucas', '.sig']);

class ArchiveError extends Error {
  constructor(message) { super(message); this.name = 'ArchiveError'; }
}

function normalize(source) {
  if (typeof source !== 'string' || /[\x00-\x1f]/.test(source)) {
    throw new ArchiveError('Un chemin du ZIP est invalide.');
  }
  const clean = source.replace(/\\/g, '/');
  const segments = clean.split('/').filter(part => part !== '' && part !== '.');
  if (clean.startsWith('/') || segments.some(part => part === '..'
      || /[:<>"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new ArchiveError('Chemin non pris en charge dans le ZIP : ' + source);
  }
  return { source, parts: segments, rel: segments.join('/'), directory: /[\\/]$/.test(source) };
}

function suffix(parts, anchor) {
  const lower = parts.map(p => p.toLowerCase());
  for (let i = 0; i <= parts.length - anchor.length; i++) {
    if (anchor.every((p, j) => lower[i + j] === p)) return parts.slice(i + anchor.length);
  }
  return undefined;
}

function descendant(entry, prefix) {
  const key = entry.rel.toLowerCase();
  const root = prefix.toLowerCase();
  return root === '' || key.startsWith(root + '/');
}

function relativeTo(entry, root) {
  return root === '' ? entry.parts : entry.rel.slice(root.length + 1).split('/');
}

function runtimePath(layout) {
  return layout === 'flat' ? BIN : path.join(BIN, 'ue4ss');
}

function documentary(entry) {
  return /\.(txt|md|pdf|url|html?|rtf|png|jpe?g|webp|gif|pdb|log)$/i.test(entry.rel)
    || /(^|\/)(license[^/]*|changelog[^/]*|readme[^/]*|info\.json|\.ds_store|thumbs\.db)$/i.test(entry.rel);
}

function isProtected(destination) {
  const d = destination.replace(/\\/g, '/');
  return /(^|\/)saved(\/|$)/i.test(d)
    || /(^|\/)MotorTown(?:-Win64-(?:Shipping|Test))?\.exe$/i.test(d)
    || /(^|\/)(MotorTown-(Windows|WindowsNoEditor)|pakchunk\d+-(Windows|WindowsNoEditor))([._-].*)?\.(pak|utoc|ucas|sig)$/i.test(d);
}

function validateContainers(destinations) {
  const names = new Set(destinations.map(d => d.toLowerCase()));
  for (const name of names) {
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    if (ext === '.utoc' && !names.has(stem + '.ucas')) {
      throw new ArchiveError('Archive IoStore incomplète : ' + path.basename(stem) + '.ucas manque.');
    }
    if (ext === '.ucas' && !names.has(stem + '.utoc')
        && !names.has(stem.replace(/_s\d+$/, '') + '.utoc')) {
      throw new ArchiveError('Archive IoStore incomplète : le fichier .utoc associé à ' + path.basename(name) + ' manque.');
    }
    if (ext === '.sig' && !names.has(stem + '.pak')) {
      throw new ArchiveError('La signature ' + path.basename(name) + ' est fournie sans son PAK.');
    }
  }
}

/** Produce Vortex instructions only. Never execute an archive or write to the game. */
function planArchive(files, options = {}) {
  const entries = files.map(normalize).filter(e => !e.directory && e.parts.length > 0)
    .filter(e => !e.parts.some(p => /^(?:__MACOSX|\.git)$/i.test(p)));
  if (entries.length === 0) throw new ArchiveError('Le ZIP ne contient aucun fichier de mod.');

  const runtimeDlls = entries.filter(e => path.basename(e.rel).toLowerCase() === 'ue4ss.dll');
  if (runtimeDlls.length > 1) {
    throw new ArchiveError('Ce ZIP contient plusieurs versions de UE4SS. Installe une seule variante à la fois.');
  }
  const runtimeDll = runtimeDlls[0];
  const shippedLayout = runtimeDll
    ? (runtimeDll.parts[runtimeDll.parts.length - 2]?.toLowerCase() === 'ue4ss' ? 'modern' : 'flat')
    : undefined;
  if (shippedLayout && options.installedLayout && options.installedLayout !== shippedLayout) {
    throw new ArchiveError('Le ZIP utilise une autre disposition UE4SS que celle installée. Retire l’ancienne installation UE4SS avant de changer de disposition.');
  }
  const layout = shippedLayout || options.installedLayout || 'modern';
  const runtimeRoot = runtimeDll ? runtimeDll.parts.slice(0, -1).join('/') : undefined;
  const rt = runtimePath(layout);

  const modRoots = [];
  for (const entry of entries) {
    if (!/(^|\/)(scripts\/main\.lua|dlls\/main\.dll)$/i.test(entry.rel)) continue;
    const parts = entry.parts.slice(0, -2);
    const name = parts.length ? parts[parts.length - 1] : safeName(options.modName || 'MotorTownMod');
    if (/^(mods|ue4ss|win64|binaries|motortown)$/i.test(name)) {
      throw new ArchiveError('Le dossier du script doit porter le nom du mod : NomDuMod/Scripts/main.lua.');
    }
    const root = parts.join('/');
    if (!modRoots.some(m => m.root.toLowerCase() === root.toLowerCase())) modRoots.push({ root, name });
  }
  const reshade = entries.some(e => /^reshade\.ini$/i.test(path.basename(e.rel)));
  const proxyNames = /^(?:dwmapi|dinput8|xinput1_3|xinput9_1_0|version|winmm)\.dll$/i;
  const copies = [];
  const ignored = [];
  const unknown = [];
  const luaNames = new Set();
  let requiresUE4SS = false;
  let hasLogicMods = false;

  for (const entry of entries) {
    const base = path.basename(entry.rel);
    const ext = path.extname(base).toLowerCase();
    let dest;
    const explicitPak = suffix(entry.parts, ['motortown', 'content', 'paks'])
      ?? suffix(entry.parts, ['content', 'paks']) ?? suffix(entry.parts, ['paks']);
    const logic = suffix(entry.parts, ['logicmods']);
    const explicitBin = suffix(entry.parts, ['motortown', 'binaries', 'win64'])
      ?? suffix(entry.parts, ['binaries', 'win64']) ?? suffix(entry.parts, ['win64']);
    const explicitUE = suffix(entry.parts, ['ue4ss']);
    const explicitMods = suffix(entry.parts, ['mods']);
    const mod = modRoots.find(m => descendant(entry, m.root));

    if (!runtimeDll && /^mods\.txt$/i.test(base) && (!mod || mod.root === '')) {
      ignored.push(entry.rel); continue;
    }
    if (CONTAINERS.has(ext) && !(mod && !explicitPak && !logic)) {
      if (logic) {
        dest = path.join(PAKS, 'LogicMods', ...logic);
        hasLogicMods = true;
        requiresUE4SS = true;
      } else if (explicitPak) {
        dest = path.join(PAKS, ...explicitPak);
      } else {
        // Gift-wrapped PAKs are common. Colliding variants are rejected below.
        dest = path.join(PAKS, base);
      }
    } else if (runtimeDll && descendant(entry, runtimeRoot)) {
      dest = path.join(rt, ...relativeTo(entry, runtimeRoot));
    } else if (mod) {
      dest = path.join(rt, 'Mods', mod.name, ...relativeTo(entry, mod.root));
      luaNames.add(mod.name);
      requiresUE4SS = true;
    } else if (explicitUE?.length) {
      if (!runtimeDll && /^mods\.txt$/i.test(explicitUE.join('/'))) {
        ignored.push(entry.rel); continue;
      }
      dest = path.join(rt, ...explicitUE);
      requiresUE4SS = true;
    } else if (explicitMods?.length >= 2) {
      dest = path.join(rt, 'Mods', ...explicitMods);
      requiresUE4SS = true;
    } else if (runtimeDll && proxyNames.test(base)) {
      dest = path.join(BIN, base);
    } else if (explicitBin?.length) {
      if (!runtimeDll && /^mods\.txt$/i.test(explicitBin.join('/'))) {
        ignored.push(entry.rel); continue;
      }
      // Explicit Win64 paths also cover native plugins and ReShade distributions.
      dest = path.join(BIN, ...explicitBin);
    } else if (!runtimeDll && /^mods\.txt$/i.test(base) && modRoots.length) {
      // A mod-only ZIP must not replace the activation list of every other mod.
      ignored.push(entry.rel); continue;
    } else if (reshade && /^(?:reshade[^/]*\.ini|dxgi\.dll|d3d11\.dll)$/i.test(base)) {
      dest = path.join(BIN, base);
    } else if (reshade && suffix(entry.parts, ['reshade-shaders'])) {
      dest = path.join(BIN, 'reshade-shaders', ...suffix(entry.parts, ['reshade-shaders']));
    } else if (documentary(entry)) {
      ignored.push(entry.rel); continue;
    } else {
      unknown.push(entry.rel); continue;
    }

    if (isProtected(dest)) {
      throw new ArchiveError('Ce paquet cible un fichier du jeu ou une sauvegarde : ' + entry.rel + '. Ce type de remplacement n’est pas pris en charge.');
    }
    if (dest.toLowerCase().includes('\\mods\\') && dest.toLowerCase().startsWith(rt.toLowerCase())) {
      requiresUE4SS = true;
    }
    copies.push({ type: 'copy', source: entry.source, destination: dest });
  }

  if (unknown.length) {
    throw new ArchiveError('Emplacement indéterminé pour : ' + unknown.slice(0, 8).join(', ')
      + '. Utilise une archive avec les dossiers Paks, LogicMods, Win64 ou NomDuMod/Scripts/main.lua.');
  }
  if (!copies.length) throw new ArchiveError('Aucun PAK, script UE4SS ou fichier Win64 reconnu dans ce ZIP.');

  const pakOnly = !hasLogicMods && copies.every(i => CONTAINERS.has(path.extname(i.destination).toLowerCase()));
  if (pakOnly) {
    for (const i of copies) i.destination = path.basename(i.destination);
  }
  const destinations = new Map();
  for (const instruction of copies) {
    const key = instruction.destination.toLowerCase();
    if (destinations.has(key)) {
      throw new ArchiveError('Deux variantes ciblent ' + instruction.destination + ' : '
        + destinations.get(key) + ' et ' + instruction.source + '. Garde une seule variante dans le ZIP.');
    }
    destinations.set(key, instruction.source);
  }
  validateContainers(copies.map(i => i.destination));

  const generated = [];
  if (!runtimeDll) {
    for (const name of luaNames) {
      const marker = path.join(rt, 'Mods', name, 'enabled.txt');
      if (!destinations.has(marker.toLowerCase())) generated.push({ type: 'generatefile', destination: marker, data: '' });
    }
  }
  const pakFiles = copies.filter(i => path.extname(i.destination).toLowerCase() === '.pak')
    .map(i => path.basename(i.destination));
  const components = [pakFiles.length && 'PAK', copies.some(i => /\.utoc$/i.test(i.destination)) && 'IoStore',
    runtimeDll && 'UE4SS', requiresUE4SS && 'Scripts UE4SS', hasLogicMods && 'LogicMods', reshade && 'ReShade'].filter(Boolean);
  if (!components.length) components.push('Win64');
  const attributes = {
    mtInstallerVersion: '2.0.2', mtComponents: components, mtRequiresUE4SS: requiresUE4SS,
    mtIncludesUE4SS: !!runtimeDll, mtUE4SSLayout: requiresUE4SS || runtimeDll ? layout : null,
    mtLogicMods: hasLogicMods, mtLuaModNames: [...luaNames], mtPakFiles: pakFiles,
    mtIgnoredFiles: ignored,
  };
  return {
    instructions: [...copies, ...generated,
      { type: 'setmodtype', value: pakOnly ? PAK_TYPE : ROOT_TYPE },
      ...Object.entries(attributes).map(([key, value]) => ({ type: 'attribute', key, value }))],
  };
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.]+|[.]+$/g, '').slice(0, 100) || 'MotorTownMod';
}

module.exports = { planArchive, normalize, ArchiveError, runtimePath, validateContainers, PAKS, BIN, PAK_TYPE, ROOT_TYPE };

},
"lib/order.js": function(module, exports, require, __dirname) {
'use strict';

const path = require('path').win32;
const crypto = require('crypto');
const { PAK_TYPE } = require('./archive');
const GAME_ID = 'motortown'; // Preserve the ID used by Tristan's original extension.

function activeProfile(state) {
  const id = state.settings?.profiles?.activeProfileId;
  const profile = state.persistent?.profiles?.[id];
  return profile?.gameId === GAME_ID ? profile : undefined;
}

function enabledMods(state) {
  const profile = activeProfile(state);
  const mods = state.persistent?.mods?.[GAME_ID] || {};
  return profile ? Object.keys(profile.modState || {})
    .filter(id => profile.modState[id]?.enabled && mods[id]).map(id => mods[id]) : [];
}

function deploymentFolder(state, mod) {
  const profile = activeProfile(state);
  const order = profile ? state.persistent?.loadOrder?.[profile.id] || {} : {};
  const validPos = entry => Number.isInteger(entry?.pos) && entry.pos >= 0 && entry.pos < 1000000;
  let pos = order[mod.id]?.pos;
  if (!validPos(order[mod.id])) {
    const positions = Object.values(order).filter(validPos).map(e => e.pos);
    const pending = enabledMods(state).filter(m => m.type === PAK_TYPE && !validPos(order[m.id]))
      .map(m => m.id).sort();
    pos = Math.max(-1, ...positions) + 1 + Math.max(0, pending.indexOf(mod.id));
  }
  const rank = String(Math.min(pos, 999999)).padStart(6, '0');
  const token = crypto.createHash('sha256').update(String(mod.id)).digest('hex').slice(0, 16);
  // Vortex owns these paths and cleans up the old paths when redeploying/purging.
  // Original PAK basenames and their _P suffixes remain intact.
  return path.join('~mods', 'Vortex', rank + '-' + token);
}

function orderWarnings(mods) {
  const files = mods.filter(m => m.type === PAK_TYPE).flatMap(m => m.attributes?.mtPakFiles || []);
  const groups = new Set(files.map(file => {
    const numeric = /_(\d+)_P\.pak$/i.exec(file);
    return numeric ? 'patch-' + Number(numeric[1]) : /_P\.pak$/i.test(file) ? 'patch' : 'normal';
  }));
  return groups.size > 1 ? ['Les PAK ont des suffixes de priorité différents (_P, _nombre_P ou aucun). '
    + 'L’ordre des dossiers Vortex ne remplace pas les priorités internes du moteur Unreal.'] : [];
}

module.exports = { GAME_ID, activeProfile, enabledMods, deploymentFolder, orderWarnings };

},
"lib/runtime.js": function(module, exports, require, __dirname) {
'use strict';

const fs = require('fs').promises;
const path = require('path');
const { BIN, PAKS, runtimePath, PAK_TYPE } = require('./archive');
const { GAME_ID, enabledMods, orderWarnings } = require('./order');
const EXE = BIN + '\\MotorTown-Win64-Shipping.exe';

function diskPath(root, relative) { return path.join(root, ...relative.split(/[\\/]+/)); }
async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
function discovery(api) { return api.getState().settings?.gameMode?.discovered?.[GAME_ID]; }

async function detectLayout(root) {
  if (!root) return undefined;
  const modern = await exists(diskPath(root, BIN + '\\ue4ss\\UE4SS.dll'));
  const flat = await exists(diskPath(root, BIN + '\\UE4SS.dll'));
  if (modern && flat) return 'both';
  return modern ? 'modern' : flat ? 'flat' : undefined;
}

async function steamBuild(root) {
  const manifest = path.resolve(root, '..', '..', 'appmanifest_1369670.acf');
  try {
    const text = await fs.readFile(manifest, 'utf8');
    return { build: /"buildid"\s+"([^"\r\n]+)"/i.exec(text)?.[1],
      branch: /"BetaKey"\s+"([^"\r\n]+)"/i.exec(text)?.[1] || 'publique (aucune branche indiquée)' };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {};
    throw error;
  }
}

async function hasEnabledBP(root, layout) {
  const mods = diskPath(root, runtimePath(layout) + '\\Mods');
  let activation = '';
  try { activation = await fs.readFile(path.join(mods, 'mods.txt'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of ['BPModLoaderMod', 'BPModLoader']) {
    if (!await exists(path.join(mods, name, 'Scripts', 'main.lua'))) continue;
    if (await exists(path.join(mods, name, 'enabled.txt'))) return true;
    const re = new RegExp('^\\s*' + name + '\\s*:\\s*1\\s*(?:[;#].*)?$', 'im');
    if (re.test(activation)) return true;
  }
  return false;
}

async function diagnostics(api) {
  const state = api.getState();
  const game = discovery(api);
  const warnings = [];
  const lines = ['Motor Town — extension Vortex 2.0.2'];
  if (!game?.path) return { lines, warnings: ['L’installation de Motor Town n’a pas encore été sélectionnée dans Vortex.'] };
  if (!await exists(diskPath(game.path, EXE))) warnings.push('L’exécutable du jeu est introuvable dans le dossier sélectionné.');
  const build = await steamBuild(game.path);
  lines.push('Build Steam : ' + (build.build || 'non disponible'));
  lines.push('Branche Steam : ' + (build.branch || 'non disponible'));
  const mods = enabledMods(state);
  lines.push('Mods activés dans ce profil : ' + mods.length);
  lines.push('PAK avec ordre de dossiers Vortex : ' + mods.filter(m => m.type === PAK_TYPE).length);
  const layout = await detectLayout(game.path);
  lines.push('Disposition UE4SS : ' + (layout || 'non détectée'));
  if (layout === 'both') warnings.push('Deux installations UE4SS sont présentes (Win64 et Win64/ue4ss). Vérifie laquelle est utilisée avant d’ajouter des scripts.');
  if (!layout && mods.some(m => m.attributes?.mtRequiresUE4SS)) {
    warnings.push('Des mods activés ont besoin de UE4SS, mais UE4SS.dll est absent. Installe une version UE4SS compatible avec ta version de Motor Town, puis redéploie.');
  }
  if (await exists(diskPath(game.path, BIN + '\\override.txt'))) {
    warnings.push('Un override.txt UE4SS est présent. Les emplacements personnalisés UE4SS ne sont pas gérés automatiquement par cette extension.');
  }
  for (const mod of mods) {
    if (layout && layout !== 'both' && mod.attributes?.mtRequiresUE4SS
        && mod.attributes.mtUE4SSLayout !== layout) {
      warnings.push((mod.attributes?.name || mod.id) + ' a été installé pour une autre disposition UE4SS. Réinstalle ce mod depuis son archive avec le framework actuel.');
    }
  }
  if (layout && layout !== 'both' && mods.some(m => m.attributes?.mtLogicMods)
      && !await hasEnabledBP(game.path, layout)) {
    warnings.push('Un mod LogicMods est activé mais le BPModLoader de UE4SS n’est pas détecté comme actif. Vérifie le chargeur demandé par l’auteur du mod.');
  }
  warnings.push(...orderWarnings(mods));
  const old = mods.filter(m => !m.attributes?.mtInstallerVersion && m.type !== 'collection');
  if (old.length) warnings.push(old.length + ' mod(s) utilisent encore leur ancienne installation. Réinstalle-les depuis leur archive pour bénéficier du placement automatique de la version 2.0.');
  // Inspect filenames only. The official encrypted archives never need opening.
  try {
    const names = await fs.readdir(diskPath(game.path, PAKS));
    const direct = names.filter(n => /\.pak$/i.test(n)
      && !/^(MotorTown-(Windows|WindowsNoEditor)|pakchunk\d+-(Windows|WindowsNoEditor))([._-].*)?\.pak$/i.test(n));
    if (direct.length) lines.push('PAK directement dans Paks (hors ordre des nouveaux dossiers Vortex) : ' + direct.join(', '));
  } catch (error) {
    if (error.code === 'ENOENT') warnings.push('Le dossier MotorTown/Content/Paks est introuvable.');
    else throw error;
  }
  return { lines, warnings };
}

module.exports = { diskPath, exists, discovery, detectLayout, diagnostics, steamBuild, EXE };

},
"index.js": function(module, exports, require, __dirname) {
'use strict';

const path = require('path');
const fs = require('fs').promises;
const { planArchive, ArchiveError, PAKS, BIN, PAK_TYPE, ROOT_TYPE } = require('./lib/archive');
const { GAME_ID, activeProfile, enabledMods, deploymentFolder } = require('./lib/order');
const { diskPath, exists, discovery, detectLayout, diagnostics, EXE } = require('./lib/runtime');
const STEAM_ID = '1369670';

function main(context) {
  const { util, actions } = require('vortex-api');
  const Bluebird = require('bluebird');
  const asBlue = fn => (...args) => Bluebird.resolve().then(() => fn(...args));
  const api = context.api;
  context.requireVersion('>=1.9.0');

  function getRoot() {
    const root = discovery(api)?.path;
    if (!root) throw new util.ProcessCanceled('Sélectionne d’abord le dossier de Motor Town dans Vortex.');
    return root;
  }

  function showError(error) {
    api.sendNotification({ type: 'error', title: 'Motor Town', message: error.message, allowReport: false });
  }

  async function check(showAll) {
    try {
      const report = await diagnostics(api);
      if (showAll) {
        await api.showDialog('info', 'Vérifier Motor Town', {
          text: [...report.lines, '', ...(report.warnings.length ? report.warnings : ['Aucune anomalie détectée par ces vérifications.']),
            '', 'Ce diagnostic vérifie les emplacements et dépendances. Il ne teste pas les mods en jeu.'].join('\n\n'),
        }, [{ label: 'Fermer' }]);
      } else if (report.warnings.length) {
        api.sendNotification({ id: 'motortown-dependencies', type: 'warning',
          title: 'Motor Town : installation à vérifier', message: report.warnings[0],
          actions: [{ title: 'Détails', action: () => { void check(true); } }] });
      } else {
        api.dismissNotification('motortown-dependencies');
      }
    } catch (error) { showError(error); }
  }

  context.registerGame({
    id: GAME_ID,
    name: 'Motor Town: Behind The Wheel',
    queryPath: () => util.GameStoreHelper.findByAppId([STEAM_ID]).then(game => game.gamePath),
    queryModPath: () => PAKS,
    // Legacy installations retain their original destination until reinstalled.
    mergeMods: true,
    executable: () => EXE,
    requiredFiles: [EXE],
    logo: 'gameart.png',
    requiresLauncher: () => Bluebird.resolve({ launcher: 'steam' }),
    environment: { SteamAPPId: STEAM_ID, SteamAppId: STEAM_ID },
    details: { steamAppId: Number(STEAM_ID), nexusPageId: 'motortownbehindthewheel',
      nxmLinkId: 'motortownbehindthewheel' },
    setup: asBlue(async game => {
      if (!await exists(diskPath(game.path, EXE))) throw new util.ProcessCanceled('Sélectionne le dossier principal de Motor Town, celui qui contient le sous-dossier MotorTown.');
      await fs.mkdir(diskPath(game.path, PAKS + '\\~mods\\Vortex'), { recursive: true });
    }),
  });

  context.registerModType(PAK_TYPE, 25, id => id === GAME_ID,
    () => diskPath(getRoot(), PAKS),
    instructions => Bluebird.resolve(instructions.some(i => i.type === 'setmodtype' && i.value === PAK_TYPE)),
    { name: 'Motor Town — PAK / IoStore', mergeMods: mod => deploymentFolder(api.getState(), mod) });

  context.registerModType(ROOT_TYPE, 25, id => id === GAME_ID,
    () => getRoot(),
    instructions => Bluebird.resolve(instructions.some(i => i.type === 'setmodtype' && i.value === ROOT_TYPE)
      || instructions.some(i => i.type === 'copy' && /^MotorTown[\\/](Binaries|Content)[\\/]/i.test(i.destination || ''))),
    { name: 'Motor Town — UE4SS / LogicMods / fichiers du jeu', mergeMods: true });

  context.registerInstaller('motortown-smart-installer', 25,
    (files, id) => Bluebird.resolve({ supported: id === GAME_ID
      && !files.some(file => /(^|[\\/])fomod[\\/]ModuleConfig\.xml$/i.test(file)), requiredFiles: [] }),
    asBlue(async (files, destination, id) => {
      if (id !== GAME_ID) throw new util.ProcessCanceled('Cet installateur est réservé à Motor Town.');
      const root = getRoot();
      const installedLayout = await detectLayout(root);
      const scriptPlacement = files.some(file => /(^|[\\/])(ue4ss|mods|scripts|dlls)[\\/]|UE4SS\.dll$/i.test(file));
      if (scriptPlacement && installedLayout === 'both') throw new util.ProcessCanceled('Deux installations UE4SS sont présentes. Corrige ce doublon avant d’installer un script avec cet installateur.');
      if (await exists(diskPath(root, BIN + '\\override.txt'))
          && scriptPlacement) {
        throw new util.ProcessCanceled('Cette installation UE4SS utilise override.txt. Le placement vers un dossier personnalisé doit être effectué manuellement.');
      }
      // When a framework is installed in Vortex but not deployed yet, use its layout.
      const pendingLayouts = new Set(enabledMods(api.getState()).filter(m => m.attributes?.mtIncludesUE4SS)
        .map(m => m.attributes?.mtUE4SSLayout).filter(Boolean));
      if (scriptPlacement && !installedLayout && pendingLayouts.size > 1) throw new util.ProcessCanceled('Plusieurs dispositions UE4SS sont activées dans ce profil. Garde un seul framework.');
      try {
        return planArchive(files, { installedLayout: installedLayout === 'both' ? undefined : installedLayout || [...pendingLayouts][0], modName: path.basename(destination) });
      } catch (error) {
        if (error instanceof ArchiveError) throw new util.ProcessCanceled(error.message);
        throw error;
      }
    }));

  // The established page API stores a per-profile order in Vortex itself. All
  // actual file moves are performed by Vortex deployment, never by this callback.
  const previousOrders = new Map();
  context.registerLoadOrderPage({
    gameId: GAME_ID,
    gameArtURL: path.join(__dirname, 'gameart.png'),
    displayCheckboxes: false,
    filter: mods => mods.filter(mod => mod.type === PAK_TYPE),
    createInfoPanel: () => 'Ordre des dossiers PAK\n\n'
      + 'Déplace les mods puis clique sur Déployer. Le numéro de dossier augmente de haut en bas. '
      + 'Les noms originaux des PAK et leurs fichiers .utoc/.ucas sont conservés. '
      + 'Cette fonction organise les dossiers ; sa priorité effective reste à vérifier dans Motor Town. '
      + 'Les suffixes _P et _nombre_P ainsi que les règles internes du moteur peuvent primer sur cet ordre. '
      + 'Les PAK internes ne sont pas fusionnés et leurs conflits d’assets ne sont pas analysés. '
      + 'Les scripts, LogicMods, paquets mixtes et anciennes installations restent dans la page Mods.',
    callback: order => {
      const profile = activeProfile(api.getState());
      if (!profile) return;
      const signature = JSON.stringify(Object.keys(order).sort().map(id => [id, order[id]?.pos]));
      if (previousOrders.get(profile.id) !== signature) {
        previousOrders.set(profile.id, signature);
        api.store.dispatch(actions.setDeploymentNecessary(GAME_ID, true));
      }
    },
  });

  const active = () => !!activeProfile(api.getState());
  context.registerAction('mod-icons', 300, 'inspect', {}, 'Vérifier Motor Town', () => { void check(true); }, active);
  context.registerAction('mod-icons', 301, 'open', {}, 'Dossier PAK', () => {
    try { Promise.resolve(util.opn(diskPath(getRoot(), PAKS))).catch(showError); } catch (error) { showError(error); }
  }, active);
  context.once(() => {
    api.events.on('gamemode-activated', id => { if (id === GAME_ID) void check(false); });
    api.events.on('did-deploy', profileId => {
      const profile = api.getState().persistent?.profiles?.[profileId];
      if (profile?.gameId === GAME_ID && active()) void check(false);
    });
  });
  return true;
}

module.exports = { default: main };

},
};
const __mtCache = Object.create(null);
function __mtLoad(id) {
  if (__mtCache[id]) return __mtCache[id].exports;
  const mod = { exports: {} };
  __mtCache[id] = mod;
  function localRequire(request) {
    if (!request.startsWith('.')) return require(request);
    const posix = require('path').posix;
    let resolved = posix.normalize(posix.join(posix.dirname(id), request));
    if (!resolved.endsWith('.js')) resolved += '.js';
    if (!Object.prototype.hasOwnProperty.call(__mtModules, resolved)) {
      throw new Error('Module interne manquant : ' + resolved);
    }
    return __mtLoad(resolved);
  }
  __mtModules[id](mod, mod.exports, localRequire, __dirname);
  return mod.exports;
}
module.exports = __mtLoad('index.js');
