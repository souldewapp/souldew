// Server error messages in the player's language. The server answers { error, code, vars } (server/lib/fsutil.mjs
// httpError); its `error` text is German and stays the fallback for codes this table doesn't know.
import { t } from './i18n.mjs';

const TEXTS = {
  requestTooLarge: () => t('err.requestTooLarge', 'Request too large'),
  fileTooLarge: () => t('err.fileTooLarge', 'File too large'),
  emptyFile: () => t('err.emptyFile', 'Empty file'),
  badJson: () => t('err.badJson', 'Invalid JSON'),
  jsonObject: () => t('err.jsonObject', 'JSON object expected'),
  idMissing: () => t('err.idMissing', 'ID missing'),
  emptySave: () => t('err.emptySave', 'Empty save file – not saved'),
  noSaveYet: () => t('err.noSaveYet', 'No save file yet'),
  runNotFound: () => t('err.runNotFound', 'Run not found'),
  runBuilding: () => t('err.runBuilding', 'This run is being built right now'),
  runIsLocal: () => t('err.runIsLocal', 'This run was created on this computer and can’t be replaced by a run pack'),
  noRomForPlayer: () => t('err.noRomForPlayer', 'No ROM for this player'),
  romNotBuilt: () => t('err.romNotBuilt', 'The ROM for this player hasn’t been built yet'),
  badPath: () => t('err.badPath', 'Invalid path'),
  badPlayer: () => t('err.badPlayer', 'Invalid player'),
  badSlot: () => t('err.badSlot', 'Invalid slot'),
  badRun: () => t('err.badRun', 'Invalid run'),
  badRunId: () => t('err.badRunId', 'Invalid run ID'),
  badMode: (v) => t('err.badMode', 'Unknown mode: {mode}', v),
  playersGap: () => t('err.playersGap', 'Players must be p1 to p4 without gaps'),
  noBuildPlayer: () => t('err.noBuildPlayer', 'No valid player to build'),
  packInvalid: () => t('err.packInvalid', 'Not a valid run pack'),
  packBroken: (v) => t('err.packBroken', 'The run pack is damaged ({what})', v),
  badWebhook: () => t('err.badWebhook', 'Invalid Discord webhook URL'),
  unknownEmulator: () => t('err.unknownEmulator', 'Unknown emulator'),
  badEmulatorPath: () => t('err.badEmulatorPath', 'Invalid emulator path'),
  scriptMissing: () => t('err.scriptMissing', 'The mGBA script is missing – restart souldew to create it again'),
  emulatorRunning: () => t('err.emulatorRunning', 'The external emulator is still running. Save in the game, close the emulator, then try again.'),
  noWatchedSave: () => t('err.noWatchedSave', 'No watched save file for this run.'),
  graveyardCheckFailed: () => t('err.graveyardCheckFailed', 'The check after editing failed – the save file was not changed.'),
  presetName: () => t('err.presetName', 'The preset needs a name'),
  presetNotFound: () => t('err.presetNotFound', 'Preset not found'),
  presetValues: () => t('err.presetValues', 'The preset’s settings are missing'),
  presetLimit: (v) => t('err.presetLimit', 'At most {max} presets', v),
  noFile: () => t('err.noFile', 'No file given'),
  notInLibrary: () => t('err.notInLibrary', 'The file is not in a library folder'),
  fileNotFound: () => t('err.fileNotFound', 'File not found'),
  fileNotFoundNamed: (v) => t('err.fileNotFoundNamed', 'File not found: {name}', v),
  notInArchive: (v) => t('err.notInArchive', '“{entry}” not found in the archive', v),
  uploadType: () => t('err.uploadType', 'Only ROMs (.gb/.gbc/.gba/.nds), patches or .zip'),
  notRom: () => t('err.notRom', 'Not a ROM file'),
  notPatch: () => t('err.notPatch', 'Not a patch file'),
  badCoverId: () => t('err.badCoverId', 'Invalid picture ID'),
  coverType: () => t('err.coverType', 'Only PNG, JPEG or WebP pictures'),
  coverTooLarge: () => t('err.coverTooLarge', 'Picture too large (4 MB at most)'),
  noCover: () => t('err.noCover', 'No picture of your own yet'),
};

/** The text to show for a failed API call: translated when the server sent a known code, else its own message. */
export function serverErrorText({ code, vars, error } = {}, status) {
  const text = code && TEXTS[code] ? TEXTS[code](vars || {}) : '';
  return text || error || (status ? `HTTP ${status}` : '');
}
