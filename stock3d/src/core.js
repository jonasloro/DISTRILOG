export const SECTORS = Object.freeze(['RM', 'QA', 'PR', 'ET', 'EC']);
export const FLAT = Object.freeze(['ET', 'EC']);
export function positionKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}
export function classifyPosition(position) {
  if (!position || !SECTORS.includes(position.setor)) return 'unmapped';
  return Number(position.ocupado) > 0 ? 'busy' : 'free';
}
export function unitsForSector(sector) { return FLAT.includes(sector) ? 'caixas pretas' : 'volumes'; }
export function validPosition(p) {
  return Boolean(p && typeof p.address === 'string' && SECTORS.includes(p.setor) && (FLAT.includes(p.setor) ? /^\d+(ET|EC)\d{2}$/.test(p.address) : /^\d+(RM|QA|PR)\d{2}[A-C]$/.test(p.address)) && Number.isFinite(Number(p.ocupado)) && Number(p.ocupado) >= 0);
}
export function filterPositions(positions, sector, query, matching = null) {
  const q = positionKey(query);
  return positions.filter(p => (sector === 'TODOS' || p.setor === sector) && (
    !q || p.address.toUpperCase().includes(q) || (matching instanceof Set && matching.has(p.address))
  ));
}
export function parseBindings(input) {
  if (!input || input.schema !== 'distrilog-stock3d-anchors-v1' || typeof input.model !== 'string' || !input.anchors || typeof input.anchors !== 'object' || Array.isArray(input.anchors)) throw new Error('Arquivo de vínculos inválido.');
  const clean = {};
  for (const [address, coordinates] of Object.entries(input.anchors)) {
    const k = positionKey(address);
    if (!/^\d+(RM|QA|PR|ET|EC)\d{2}[A-C]?$/.test(k) || !Array.isArray(coordinates) || coordinates.length !== 3 || !coordinates.every(v => Number.isFinite(v) && Math.abs(v) < 1e7)) throw new Error(`Vínculo inválido: ${k.slice(0, 30)}`);
    clean[k] = [...coordinates];
  }
  if (Object.keys(clean).length > 1000) throw new Error('Mapa de vínculos ultrapassa o limite.');
  return {schema: input.schema, model: input.model, anchors: clean};
}
export function positionStats(positions, bindings = {}) {
  return {total: positions.length, busy: positions.filter(p => Number(p.ocupado) > 0).length,
    mapped: positions.filter(p => Boolean(bindings[p.address])).length};
}
export function isSketchup(filename) { return /\.(skb|skp)$/i.test(filename); }
export function isGLB(filename) { return /\.glb$/i.test(filename); }
