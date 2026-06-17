// statsLoader.mjs — U-65: load and index historical costs from app.stats by [goal][risk] tuple.
// Thin re-export that names the function by its public role (loading + indexing stats) rather
// than exposing the internal transform name. Callers import loadHistoricalStats; the rolling-sample
// reduction lives in forecaster.mjs and stays the single source of truth.
export { statsToHistorical as loadHistoricalStats } from './forecaster.mjs';
