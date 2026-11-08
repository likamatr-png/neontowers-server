/**
 * НЕОНОВЫЕ БАШНИ — общий игровой модуль (клиент + сервер).
 * Битва как на референсе: много башен с гарнизонами, марши колонн,
 * захват зданий, счёт команд, события «ВЛАСТЬ …».
 */

// ---------- Константы матча ----------
export const MAX_PLAYERS = 4
/** Окно поиска игроков (мс): не нашли никого за 30 с — старт с ботами */
export const SEARCH_WINDOW_MS = 30_000
/** Длительность матча */
export const MATCH_DURATION_MS = 10 * 60_000
/** Пока не прошло это время, боты не трогают владения соперников (спокойный разгон) */
export const BOT_GRACE_MS = 55_000
/** Медленное восстановление гарнизона нейтральных точек */
export const NEUTRAL_REGEN_PER_S = 0.1
/** События-«Власти»: интервал и длительность */
export const EVENT_INTERVAL_MS = 70_000
export const EVENT_DURATION_MS = 30_000
export const TOWER_MAX_LEVEL = 3
export const BUILDING_MAX_LEVEL = 3
export const RESEARCH_MAX_LEVEL = 5

/** Скорость марша, мировых пикселей в секунду */
export const MARCH_SPEED = 100
export const MIN_MARCH_UNITS = 5

export type BuildingType = 'mine' | 'sawmill' | 'lab' | 'barracks' | 'radio' | 'depot'
export type ResourceKey = 'gold' | 'wood' | 'ideas'

export const BUILDING_NAMES: Record<BuildingType, string> = {
  mine: 'Золотая шахта',
  sawmill: 'Лесопилка',
  lab: 'Лаборатория',
  barracks: 'Казарма',
  radio: 'Радиовышка',
  depot: 'Снабжение',
}

/** Базовый доход зданий (в секунду, умножается на уровень) */
export const BUILDING_RATE: Record<BuildingType, { res: ResourceKey | 'none'; rate: number }> = {
  mine: { res: 'gold', rate: 30 },
  sawmill: { res: 'wood', rate: 25 },
  lab: { res: 'ideas', rate: 5 },
  barracks: { res: 'none', rate: 0 },
  radio: { res: 'none', rate: 0 },
  depot: { res: 'none', rate: 0 },
}

export const BUILDING_DESC: Record<BuildingType, string> = {
  mine: '+30 золота/с за уровень',
  sawmill: '+25 дерева/с за уровень',
  lab: '+5 идей/с за уровень',
  barracks: '+25% к пополнению башен',
  radio: '+15% к атаке армии',
  depot: '+20% к защите башен',
}

export const BUILDING_EFFECT: Record<BuildingType, string> = {
  mine: 'доход',
  sawmill: 'доход',
  lab: 'доход',
  barracks: 'пополнение',
  radio: 'атака',
  depot: 'защита',
}

/** Мелкий пассивный доход командира */
export const BASE_INCOME: Record<ResourceKey, number> = { gold: 2, wood: 1, ideas: 0.2 }

/** Пополнение гарнизона башни */
export const REGEN_PER_S = 0.55
export const REGEN_PER_BARRACKS = 0.25
export const REGEN_BUILDING_PER_S = 0.15
export const BUILDING_CAP = 20

export function towerCap(level: number): number {
  return 25 + level * 15
}

export function towerDefMult(level: number): number {
  return 1 + (level - 1) * 0.3
}

export function buildingUpgradeCost(next: number): { gold: number; wood: number } {
  return { gold: 500 * next, wood: 300 * next }
}

export function towerUpgradeCost(next: number): { gold: number; wood: number } {
  return next === 2 ? { gold: 600, wood: 250 } : { gold: 1400, wood: 600 }
}

export function hireCost(count: number): number {
  return Math.round(count * 8)
}

export function researchCost(next: number): number {
  return 50 * next
}

export const RESEARCH_ATTACK_PER_LEVEL = 0.08
export const RADIO_BONUS = 0.15
export const DEPOT_BONUS = 0.2
export const BARRACKS_REGEN_MULT = 0.25

/** Цена найма одной пачки юнитов */
export const HIRE_PACK = 15

// ---------- Цвета и имена (как на референсе: синие/красные/фиолетовые/зелёные) ----------
export const PLAYER_COLORS = ['#38bdf8', '#f87171', '#c084fc', '#4ade80']
export const PLAYER_COLORS_DIM = ['#38bdf833', '#f8717133', '#c084fc33', '#4ade8033']
export const PLAYER_TEAM_NAMES = ['Синие', 'Красные', 'Фиолетовые', 'Зелёные']

/** Имена для игроков под управлением ИИ — обычные, как у живых людей */
export const BOT_NAMES = [
  'Ваня', 'Вася', 'Петя', 'Коля', 'Саша', 'Дима',
  'Макс', 'Женя', 'Лёша', 'Гриша', 'Толя', 'Стас',
  'Рома', 'Игорь', 'Артём', 'Кирилл',
]

// ---------- События «ВЛАСТЬ …» ----------
export interface EventDef {
  kind: 'economy' | 'war' | 'ideas' | 'speed' | 'builders'
  name: string
  desc: string
}

export const EVENT_DEFS: EventDef[] = [
  { kind: 'economy', name: 'ВЛАСТЬ ЭКОНОМИКИ', desc: 'Добыча золота ×2' },
  { kind: 'war', name: 'ВЛАСТЬ ВОЙНЫ', desc: 'Атака армии +40%' },
  { kind: 'ideas', name: 'ВЛАСТЬ ИДЕЙ', desc: 'Добыча идей ×2' },
  { kind: 'speed', name: 'ВЛАСТЬ СКОРОСТИ', desc: 'Скорость маршей ×1.8' },
  { kind: 'builders', name: 'ВЛАСТЬ СТРОИТЕЛЕЙ', desc: 'Улучшения дешевле на 40%' },
]

export type EventKind = EventDef['kind']

export function eventKindActive(kind: EventKind, ev: ActiveEvent | null): boolean {
  return !!ev && ev.kind === kind
}

export interface ActiveEvent {
  kind: EventKind
  name: string
  desc: string
  endsAt: number
}

// ---------- Магазин: скины башен (косметика + перки), ценовые уровни ----------
export interface SkinDef {
  id: string
  name: string
  /** Основной цвет корпуса башни */
  body: string
  /** Цвет свечения/контура */
  glow: string
  price: number
  perk: string | null
  perkGold?: number
  perkRegen?: number
  perkDamage?: number
  /** Секретный лисий скин — не продаётся */
  fox?: boolean
}

/** Скины, доступные в магазине (от дешёвых до люксовых) */
export const SKINS: SkinDef[] = [
  { id: 'standard', name: 'Стандарт', body: '#0e1822', glow: '#5b7a95', price: 0, perk: null },
  { id: 'leaf', name: 'Листик', body: '#0d1f0e', glow: '#86efac', price: 150, perk: null },
  { id: 'sand', name: 'Песчаный ветер', body: '#231a08', glow: '#fcd34d', price: 350, perk: null },
  { id: 'emerald', name: 'Изумрудный дракон', body: '#0c1f16', glow: '#34d399', price: 600, perk: '+2% к добыче золота', perkGold: 0.02 },
  { id: 'royal', name: 'Золото королей', body: '#241c07', glow: '#fbbf24', price: 900, perk: '+5% к добыче золота', perkGold: 0.05 },
  { id: 'rose', name: 'Розовый рассвет', body: '#230d16', glow: '#fda4af', price: 1200, perk: '+1 к пополнению башен', perkRegen: 1 },
  { id: 'frost', name: 'Кристалл льда', body: '#0a1c22', glow: '#22d3ee', price: 1600, perk: '+2 к пополнению башен', perkRegen: 2 },
  { id: 'ocean', name: 'Океанская бездна', body: '#081726', glow: '#38bdf8', price: 2200, perk: '+4% к добыче золота', perkGold: 0.04 },
  { id: 'crimson', name: 'Багровый кошмар', body: '#220b10', glow: '#fb7185', price: 2800, perk: '+5% к урону армии', perkDamage: 0.05 },
  { id: 'phoenix', name: 'Феникс', body: '#26100a', glow: '#fb923c', price: 3800, perk: '+6% к золоту, +1 к пополнению', perkGold: 0.06, perkRegen: 1 },
  { id: 'void', name: 'Пустота', body: '#120a1f', glow: '#c084fc', price: 4500, perk: '+10% золота и +4% урона', perkGold: 0.1, perkDamage: 0.04 },
  { id: 'galaxy', name: 'Галактика', body: '#0b0f26', glow: '#818cf8', price: 6000, perk: '+8% к урону армии', perkDamage: 0.08 },
  { id: 'dragonlord', name: 'Повелитель драконов', body: '#1a0f05', glow: '#f59e0b', price: 9000, perk: '+12% золота, +8% урона, +3 к пополнению', perkGold: 0.12, perkDamage: 0.08, perkRegen: 3 },
]

/** Секретный лисий скин — выдаётся только за скрытый админ-промокод */
export const FOX_SKIN: SkinDef = {
  id: 'foxbase',
  name: 'Лисья база',
  body: '#8a3d12',
  glow: '#fb923c',
  price: 0,
  perk: '🦊 Секретная лисья база',
  fox: true,
}

/** Все скины, включая секретные (для отрисовки) */
export const ALL_SKIN_DEFS: SkinDef[] = [...SKINS, FOX_SKIN]

export function skinById(id: string): SkinDef {
  return ALL_SKIN_DEFS.find((s) => s.id === id) ?? SKINS[0]
}

/** Ценовые уровни для витрины магазина */
export function skinTier(price: number): 0 | 1 | 2 | 3 {
  if (price < 900) return 0
  if (price < 2800) return 1
  if (price < 6000) return 2
  return 3
}

export const SKIN_TIER_NAMES = ['Дешёвые', 'Средние', 'Дорогие', 'Люксовые']

// Промокоды проверяются ТОЛЬКО на игровом сервере и хранятся там в скрытом виде,
// чтобы их нельзя было прочитать в коде приложения.

// ---------- Награда за матч (кристаллы) ----------
export function matchReward(stats: { captures: number; kills: number; score: number }, won: boolean, alive: boolean): number {
  const base = 60
  const capPts = stats.captures * 15
  const killPts = stats.kills * 80
  const scorePts = Math.min(300, Math.round(stats.score / 60))
  const winPts = won ? 250 : 0
  const alivePts = alive ? 25 : 0
  return base + capPts + killPts + scorePts + winPts + alivePts
}

// ---------- Состояние (сериализуется на клиент) ----------
export interface PlayerState {
  id: string
  name: string
  seat: number
  color: string
  isBot: boolean
  connected: boolean
  eliminated: boolean
  skin: string
  res: Record<ResourceKey, number>
  research: number
  score: number
  goldEarned: number
  stats: { captures: number; kills: number; marches: number }
}

export interface TowerState {
  id: number
  x: number
  y: number
  owner: string | null
  garrison: number
  level: number
  home: boolean
}

export interface BuildingState {
  id: number
  type: BuildingType
  x: number
  y: number
  owner: string | null
  garrison: number
  level: number
}

export interface MarchState {
  id: string
  seat: number
  color: string
  fromId: number
  toId: number
  toKind: 'tower' | 'building'
  units: number
  progress: number
  fx: number
  fy: number
  tx: number
  ty: number
}

export interface GameEvent {
  id: string
  t: number
  text: string
  color: string | null
  big?: boolean
}

export interface MatchResultRow {
  id: string
  name: string
  seat: number
  color: string
  isBot: boolean
  score: number
  captures: number
  kills: number
  won: boolean
  reward: number
  place: number
}

export interface GameState {
  id: string
  mode: 'matchmaking' | 'room'
  now: number
  createdAt: number
  endsAt: number
  tick: number
  players: PlayerState[]
  towers: TowerState[]
  buildings: BuildingState[]
  marches: MarchState[]
  event: ActiveEvent | null
  events: GameEvent[]
  over: boolean
  winner: string | null
  winReason: string | null
  results: MatchResultRow[] | null
}

// ---------- Геометрия карты (мир 1600x1000) ----------
export const MAP_W = 1600
export const MAP_H = 1000

/** Башни игроков: база + 2 аванпоста на игрока */
export const SEAT_POS = [
  { x: 150, y: 170 },
  { x: 1450, y: 170 },
  { x: 1450, y: 830 },
  { x: 150, y: 830 },
]

export const HOME_TOWER_OFFSETS = [
  { x: 180, y: -50 },
  { x: 0, y: 220 },
]

/** Нейтральные башни: [x, y, гарнизон, уровень] */
export const NEUTRAL_TOWER_DEFS: { x: number; y: number; g: number; lvl: number }[] = [
  { x: 800, y: 80, g: 20, lvl: 1 },
  { x: 800, y: 920, g: 20, lvl: 1 },
  { x: 90, y: 500, g: 18, lvl: 1 },
  { x: 1510, y: 500, g: 18, lvl: 1 },
  { x: 560, y: 320, g: 14, lvl: 1 },
  { x: 1040, y: 320, g: 14, lvl: 1 },
  { x: 560, y: 680, g: 14, lvl: 1 },
  { x: 1040, y: 680, g: 14, lvl: 1 },
  { x: 800, y: 330, g: 24, lvl: 2 },
  { x: 800, y: 670, g: 24, lvl: 2 },
  { x: 430, y: 500, g: 16, lvl: 1 },
  { x: 1170, y: 500, g: 16, lvl: 1 },
  { x: 800, y: 500, g: 35, lvl: 2 },
]

/** Нейтральные здания: тип, позиция, гарнизон */
export const NEUTRAL_BUILDING_DEFS: { type: BuildingType; x: number; y: number; g: number }[] = [
  { type: 'mine', x: 350, y: 290, g: 10 },
  { type: 'mine', x: 1250, y: 710, g: 10 },
  { type: 'sawmill', x: 1250, y: 290, g: 8 },
  { type: 'sawmill', x: 350, y: 710, g: 8 },
  { type: 'lab', x: 950, y: 430, g: 12 },
  { type: 'barracks', x: 650, y: 570, g: 12 },
  { type: 'radio', x: 800, y: 180, g: 10 },
  { type: 'depot', x: 800, y: 820, g: 10 },
]

/** Полный список стартовых башен (для сервера) */
export function initialTowers(playerIds: (string | null)[]): { x: number; y: number; owner: string | null; g: number; lvl: number; home: boolean }[] {
  const out: { x: number; y: number; owner: string | null; g: number; lvl: number; home: boolean }[] = []
  for (let seat = 0; seat < MAX_PLAYERS; seat++) {
    const base = SEAT_POS[seat]
    out.push({ x: base.x, y: base.y, owner: playerIds[seat], g: 35, lvl: 2, home: true })
    for (const o of HOME_TOWER_OFFSETS) {
      out.push({ x: base.x + o.x, y: base.y + o.y, owner: playerIds[seat], g: 20, lvl: 1, home: true })
    }
  }
  return out
}

// ---------- Формулы боя ----------
export function attackPower(
  units: number,
  research: number,
  opts: { radio?: boolean; eventWar?: boolean; skinDamage?: number } = {}
): number {
  let mult = 1 + research * RESEARCH_ATTACK_PER_LEVEL
  if (opts.radio) mult += RADIO_BONUS
  if (opts.eventWar) mult += 0.4
  mult += opts.skinDamage ?? 0
  return units * mult
}

export function defensePower(
  garrison: number,
  level: number,
  research: number,
  opts: { depot?: boolean } = {}
): number {
  let mult = towerDefMult(level) * (1 + research * RESEARCH_ATTACK_PER_LEVEL)
  if (opts.depot) mult += DEPOT_BONUS
  return garrison * mult
}

/** Итог боя: возвращает новый гарнизон защиты и выживших атакующих */
export function resolveCombat(
  attackUnits: number,
  research: number,
  atkOpts: Parameters<typeof attackPower>[2] = {},
  defGarrison: number,
  defLevel: number,
  defResearch: number,
  defOpts: Parameters<typeof defensePower>[3] = {}
): { captured: boolean; survivors: number; defLeft: number } {
  const a = attackPower(attackUnits, research, atkOpts)
  const d = defensePower(defGarrison, defLevel, defResearch, defOpts)
  if (a > d) {
    const survivors = Math.max(1, Math.round((a - d) / (1 + (atkOpts.skinDamage ?? 0) + research * RESEARCH_ATTACK_PER_LEVEL + (atkOpts.radio ? RADIO_BONUS : 0) + (atkOpts.eventWar ? 0.4 : 0))))
    return { captured: true, survivors, defLeft: 0 }
  }
  const defLeft = Math.max(0, Math.round((d - a) / towerDefMult(defLevel)))
  return { captured: false, survivors: 0, defLeft }
}

/** Доход командира в секунду */
export function computeIncome(
  towers: { owner: string | null }[],
  buildings: { owner: string | null; type: BuildingType; level: number }[],
  playerId: string,
  skinGold = 0,
  ev: ActiveEvent | null = null
): Record<ResourceKey, number> {
  const out: Record<ResourceKey, number> = { gold: BASE_INCOME.gold, wood: BASE_INCOME.wood, ideas: BASE_INCOME.ideas }
  for (const t of towers) if (t.owner === playerId) out.gold += 1.5
  for (const b of buildings) {
    if (b.owner !== playerId) continue
    const def = BUILDING_RATE[b.type]
    if (def.res !== 'none') out[def.res] += def.rate * b.level
  }
  if (ev?.kind === 'economy') out.gold *= 2
  if (ev?.kind === 'ideas') out.ideas *= 2
  out.gold *= 1 + skinGold
  return out
}

/** Пополнение гарнизона башни в секунду */
export function towerRegen(barracksCount: number, skinRegen = 0): number {
  return REGEN_PER_S * (1 + barracksCount * BARRACKS_REGEN_MULT) + skinRegen
}

/** Счёт команды (большие числа, как на референсе) */
export function computeScore(goldEarned: number, captures: number, kills: number): number {
  return Math.floor(goldEarned / 2) + captures * 60 + kills * 200
}

// ---------- Утилиты ----------
export function fmt(n: number): string {
  return Math.floor(n).toLocaleString('ru-RU')
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay)
}
