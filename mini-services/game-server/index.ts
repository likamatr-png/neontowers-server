/**
 * НЕОНОВЫЕ БАШНИ — игровой сервер (socket.io, порт 3003).
 * Матчмейкинг: очередь делится на комнаты до 4 человек — собралось 2+ — матч сразу,
 * лишние игроки ожидают следующую комнату; одиночка ждёт до 30 с, потом матч с ботами.
 * Битва: башни с гарнизонами, марши колонн, захват зданий, события «ВЛАСТЬ …».
 * Данные игроков НЕ собираются и НЕ хранятся. Промокоды проверяются ТОЛЬКО здесь,
 * в коде хранятся в обфусцированном виде (XOR) — в клиенте их нет.
 */
import { createServer } from 'http'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Server, Socket } from 'socket.io'
import * as G from '../../src/lib/game/shared'

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// Сервер не должен падать ни при каких ошибках: логируем и продолжаем работать
process.on('uncaughtException', (e) => console.error(`[game] uncaughtException:`, e))
process.on('unhandledRejection', (e) => console.error(`[game] unhandledRejection:`, e))

// ============================ СНАПШОТ МАТЧЕЙ (живучесть) ============================
// Каждые 5 секунд активные матчи сохраняются на диск; после перезапуска процесса
// (сбой, обновление, перезагрузка машины) матчи восстанавливаются, а игроки
// автоматически возвращаются в них по кнопке переподключения.
// Каталог снапшота: по умолчанию — db проекта; на своём сервере можно задать SNAPSHOT_DIR
const DB_DIR = process.env.SNAPSHOT_DIR || join(import.meta.dir, '..', '..', 'db')
const SNAPSHOT_PATH = join(DB_DIR, 'game-snapshot.json')
let snapshotDirty = false
const markDirty = () => {
  snapshotDirty = true
}

function saveSnapshot() {
  try {
    if (!snapshotDirty) return
    const live = [...games.values()].filter((g) => !g.over)
    if (live.length === 0) {
      try {
        if (existsSync(SNAPSHOT_PATH)) unlinkSync(SNAPSHOT_PATH)
      } catch {}
      snapshotDirty = false
      return
    }
    mkdirSync(DB_DIR, { recursive: true })
    writeFileSync(SNAPSHOT_PATH, JSON.stringify({ savedAt: now(), games: live }))
    snapshotDirty = false
  } catch (e) {
    console.error('[game] Не удалось сохранить снапшот:', e)
  }
}

function loadSnapshot() {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return
    const data = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as { savedAt: number; games: Game[] }
    let restored = 0
    for (const raw of data.games) {
      if (raw.over) continue
      // Просроченные матчи не восстанавливаем
      if (now() - raw.createdAt > G.MATCH_DURATION_MS + 5 * 60_000) continue
      games.set(raw.id, raw)
      for (const p of raw.players) {
        p.connected = false
        playerToGame.set(p.id, raw.id)
      }
      restored++
    }
    if (restored > 0) console.log(`[game] Восстановлено матчей после перезапуска: ${restored}`)
    else {
      try {
        unlinkSync(SNAPSHOT_PATH)
      } catch {}
    }
  } catch (e) {
    console.error('[game] Не удалось восстановить снапшот:', e)
  }
}

// ============================ СЕКРЕТЫ (ОБФУСКАЦИЯ) ============================
// Промокоды хранятся как XOR-массивы (ключ 0x5A) — в открытом виде их в коде нет.
const X = 0x5a
const deobf = (a: number[]): string => a.map((c) => String.fromCharCode(c ^ X)).join('')

const SECRET_CODES: number[][] = [
  [20, 31, 21, 20, 105, 106, 106],
  [24, 27, 9, 18, 20, 19, 111, 106, 106],
  [29, 22, 23, 109, 109, 109],
  [9, 14, 27, 8, 14, 104, 106, 104, 108],
  [14, 21, 13, 31, 8, 17, 19, 20, 29],
]
const ADMIN_CODE: number[] = [107, 105, 104, 59, 62, 55, 51, 52, 44, 105, 106, 105, 106]

const PROMO_TABLE: Record<string, { crystals: number; label: string }> = {
  [deobf(SECRET_CODES[0])]: { crystals: 300, label: 'Стартовый неон' },
  [deobf(SECRET_CODES[1])]: { crystals: 500, label: 'Башенный бонус' },
  [deobf(SECRET_CODES[2])]: { crystals: 777, label: 'Секретный код' },
  [deobf(SECRET_CODES[3])]: { crystals: 202, label: 'Новичку 2026' },
  [deobf(SECRET_CODES[4])]: { crystals: 1500, label: 'Король башен' },
}
const ADMIN_CODE_STR = deobf(ADMIN_CODE)

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) & 0xffffffff
  return (h >>> 0).toString(16)
}
/** Ключ админ-действий — выдаётся клиенту только после ввода админ-промокода */
const ADMIN_KEY = 'adm-' + djb2(ADMIN_CODE_STR + 'neon-fox-salt')

// ============================ ВНУТРЕННИЕ ТИПЫ ============================

interface Player {
  id: string
  key: string // ключ переподключения
  name: string
  seat: number
  color: string
  isBot: boolean
  connected: boolean
  eliminated: boolean
  skin: string
  res: Record<G.ResourceKey, number>
  research: number
  goldEarned: number
  stats: { captures: number; kills: number; marches: number }
  botNextThink: number
  botAggro: number
  rewarded: number | null
}

interface Tower {
  id: number
  x: number
  y: number
  owner: string | null
  garrison: number
  baseG: number // базовый гарнизон нейтральной точки (для медленного восстановления)
  level: number
  home: boolean
}

interface Building {
  id: number
  type: G.BuildingType
  x: number
  y: number
  owner: string | null
  garrison: number
  baseG: number
  level: number
}

interface March {
  id: string
  seat: number
  ownerId: string
  fromId: number
  toId: number
  toKind: 'tower' | 'building'
  units: number
  progress: number // 0..1
  fx: number
  fy: number
  tx: number
  ty: number
  dist: number
}

interface Game {
  id: string
  mode: 'matchmaking' | 'room'
  createdAt: number
  endsAt: number
  tick: number
  players: Player[] // индекс = seat
  towers: Tower[]
  buildings: Building[]
  marches: March[]
  event: G.ActiveEvent | null
  lastEventKind: G.EventKind | null
  nextEventAt: number
  events: G.GameEvent[]
  over: boolean
  winner: string | null
  winReason: string | null
  results: G.MatchResultRow[] | null
  overAt: number
  /** Все люди офлайн с этого времени (матч держим ещё 90 с — вдруг вернутся) */
  offlineSince: number
}

interface RoomMember {
  socketId: string
  name: string
  isBot: boolean
  skin?: string
}

interface Room {
  code: string
  hostSocketId: string
  members: RoomMember[]
}

// ============================ СОСТОЯНИЕ ============================

const games = new Map<string, Game>()
const playerToGame = new Map<string, string>()
const socketToPlayer = new Map<string, string>()
const rooms = new Map<string, Room>()

  // Матчмейкинг
interface Queued {
  sid: string
  name: string
  skin: string
  joinedAt: number
}
let searchQueue: Queued[] = []

function log(...args: unknown[]) {
  console.log(`[game] ${new Date().toISOString()}`, ...args)
}

function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 16) : ''
  return s.length > 0 ? s : 'Командир'
}

// ============================ СОЗДАНИЕ ИГРЫ ============================

function makePlayer(name: string, seat: number, isBot: boolean, connected: boolean, skin = 'standard'): Player {
  return {
    id: isBot ? `bot-${uid()}` : `p-${uid()}`,
    key: uid() + uid(),
    name,
    seat,
    color: G.PLAYER_COLORS[seat],
    isBot,
    connected,
    eliminated: false,
    skin,
    res: { gold: 200, wood: 130, ideas: 40 },
    research: 0,
    goldEarned: 0,
    stats: { captures: 0, kills: 0, marches: 0 },
    botNextThink: 0,
    botAggro: rnd(0.8, 1.25),
    rewarded: null,
  }
}

function createGame(
  humans: { socketId: string | null; name: string; skin?: string }[],
  mode: 'matchmaking' | 'room'
): { game: Game; auth: Map<string, { playerId: string; key: string }> } {
  const id = `g-${uid()}`
  const auth = new Map<string, { playerId: string; key: string }>()
  const players: Player[] = []
  const botNames = [...G.BOT_NAMES].sort(() => Math.random() - 0.5)
  let botIdx = 0

  for (let seat = 0; seat < G.MAX_PLAYERS; seat++) {
    const h = humans[seat]
    if (h) {
      const p = makePlayer(h.name, seat, false, !!h.socketId, h.skin || 'standard')
      players.push(p)
      if (h.socketId) {
        socketToPlayer.set(h.socketId, p.id)
        auth.set(h.socketId, { playerId: p.id, key: p.key })
        io.sockets.sockets.get(h.socketId)?.join(id)
      }
      playerToGame.set(p.id, id)
    } else {
      players.push(makePlayer(botNames[botIdx++ % botNames.length], seat, true, false))
    }
  }

  // Башни: базы и аванпосты игроков, затем нейтральные
  const towers: Tower[] = []
  let towerId = 1
  const playerIds = players.map((p) => p.id)
  for (const def of G.initialTowers(playerIds)) {
    towers.push({ id: towerId++, x: def.x, y: def.y, owner: def.owner, garrison: def.g, baseG: def.g, level: def.lvl, home: def.home })
  }
  for (const def of G.NEUTRAL_TOWER_DEFS) {
    towers.push({ id: towerId++, x: def.x, y: def.y, owner: null, garrison: def.g, baseG: def.g, level: def.lvl, home: false })
  }

  // Здания
  const buildings: Building[] = []
  for (const def of G.NEUTRAL_BUILDING_DEFS) {
    buildings.push({ id: towerId++, type: def.type, x: def.x, y: def.y, owner: null, garrison: def.g, baseG: def.g, level: 1 })
  }

  const game: Game = {
    id,
    mode,
    createdAt: now(),
    endsAt: now() + G.MATCH_DURATION_MS,
    tick: 0,
    players,
    towers,
    buildings,
    marches: [],
    event: null,
    lastEventKind: null,
    nextEventAt: now() + 50_000,
    events: [],
    over: false,
    winner: null,
    winReason: null,
    results: null,
    overAt: 0,
    offlineSince: 0,
  }
  games.set(id, game)
  // Снапшот пишем сразу: матч должен пережить сбой в любую секунду своей жизни
  markDirty()
  saveSnapshot()
  log(`Матч ${id} создан:`, players.map((p) => `${p.name}${p.isBot ? '(бот)' : ''}`).join(', '))
  return { game, auth }
}

function pushEvent(g: Game, text: string, color: string | null = null, big = false) {
  g.events.push({ id: uid(), t: now(), text, color, big })
  if (g.events.length > 40) g.events.splice(0, g.events.length - 40)
}

function serializeGame(g: Game): G.GameState {
  return {
    id: g.id,
    mode: g.mode,
    now: now(),
    createdAt: g.createdAt,
    endsAt: g.endsAt,
    tick: g.tick,
    players: g.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      color: p.color,
      isBot: p.isBot,
      connected: p.connected,
      eliminated: p.eliminated,
      skin: p.skin,
      res: { ...p.res },
      research: p.research,
      score: G.computeScore(p.goldEarned, p.stats.captures, p.stats.kills),
      goldEarned: Math.floor(p.goldEarned),
      stats: { ...p.stats },
    })),
    towers: g.towers.map((t) => ({ ...t })),
    buildings: g.buildings.map((b) => ({ ...b })),
    marches: g.marches.map((m) => ({
      id: m.id,
      seat: m.seat,
      color: g.players[m.seat]?.color ?? '#fff',
      fromId: m.fromId,
      toId: m.toId,
      toKind: m.toKind,
      units: m.units,
      progress: m.progress,
      fx: m.fx,
      fy: m.fy,
      tx: m.tx,
      ty: m.ty,
    })),
    event: g.event ? { ...g.event } : null,
    events: g.events.slice(-25),
    over: g.over,
    winner: g.winner,
    winReason: g.winReason,
    results: g.results,
  }
}

function broadcast(g: Game) {
  io.to(g.id).emit('game:state', serializeGame(g))
  markDirty()
}

// ============================ ПОМОЩНИКИ ============================

function towersOf(g: Game, playerId: string): Tower[] {
  return g.towers.filter((t) => t.owner === playerId)
}
function buildingsOf(g: Game, playerId: string): Building[] {
  return g.buildings.filter((b) => b.owner === playerId)
}
function countOwned(g: Game, playerId: string, type: G.BuildingType): number {
  return g.buildings.filter((b) => b.owner === playerId && b.type === type).length
}
function nodeById(g: Game, kind: 'tower' | 'building', id: number): Tower | Building | null {
  if (kind === 'tower') return g.towers.find((t) => t.id === id) ?? null
  return g.buildings.find((b) => b.id === id) ?? null
}
function skinOf(g: Game, ownerId: string | null): G.SkinDef {
  const p = ownerId ? g.players.find((x) => x.id === ownerId) : null
  return G.skinById(p?.skin ?? 'standard')
}

function eventCostMult(g: Game): number {
  return g.event?.kind === 'builders' ? 0.6 : 1
}

function marchSpeedMult(g: Game): number {
  return g.event?.kind === 'speed' ? 1.8 : 1
}

function aliveEnemies(g: Game, p: Player): Player[] {
  return g.players.filter((x) => !x.eliminated && x.id !== p.id)
}

function eliminate(g: Game, p: Player, killer: Player | null) {
  p.eliminated = true
  g.marches = g.marches.filter((m) => m.ownerId !== p.id)
  if (killer) {
    killer.stats.kills++
    pushEvent(g, `🏆 ${killer.name} разбил армию ${p.name} — команда выбита!`, killer.color, true)
  } else {
    pushEvent(g, `🏳 Команда ${p.name} потеряла все владения`, p.color, true)
  }
  log(`Игрок ${p.name} выбыл из ${g.id}`)
}

function checkEliminations(g: Game) {
  for (const p of g.players) {
    if (p.eliminated) continue
    if (towersOf(g, p.id).length === 0 && buildingsOf(g, p.id).length === 0) {
      const lastAttacker = g.marches.find((m) => m.ownerId !== p.id && (m.toKind === 'tower' || m.toKind === 'building'))
      const killer = lastAttacker ? g.players[lastAttacker.seat] : null
      eliminate(g, p, killer && killer.id !== p.id ? killer : null)
    }
  }
}

// ============================ ДЕЙСТВИЯ ИГРОКОВ ============================

function doMarch(g: Game, p: Player, fromId: number, toKind: 'tower' | 'building', toId: number, share: number): { ok: boolean; error?: string } {
  if (p.eliminated) return { ok: false, error: 'Вы выбыли' }
  const from = g.towers.find((t) => t.id === fromId)
  if (!from || from.owner !== p.id) return { ok: false, error: 'Это не ваша башня' }
  const target = nodeById(g, toKind, toId)
  if (!target) return { ok: false, error: 'Цель не найдена' }
  if (fromId === toId && toKind === 'tower') return { ok: false, error: 'Цель — та же башня' }
  const shareClamped = share >= 0.99 ? 1 : share >= 0.4 ? 0.5 : 0.25
  const units = Math.floor(from.garrison * shareClamped)
  if (units < G.MIN_MARCH_UNITS) return { ok: false, error: `Мало бойцов (минимум ${G.MIN_MARCH_UNITS})` }
  from.garrison -= units
  p.stats.marches++
  const d = G.dist(from.x, from.y, target.x, target.y)
  g.marches.push({
    id: uid(),
    seat: p.seat,
    ownerId: p.id,
    fromId,
    toId,
    toKind,
    units,
    progress: 0,
    fx: from.x,
    fy: from.y,
    tx: target.x,
    ty: target.y,
    dist: Math.max(1, d),
  })
  return { ok: true }
}

function resolveArrival(g: Game, m: March) {
  const p = g.players[m.seat]
  if (!p || p.eliminated) return
  const target = nodeById(g, m.toKind, m.toId)
  if (!target) return
  // Если цель уже своя — усиление
  if (target.owner === p.id) {
    const cap = m.toKind === 'tower' ? G.towerCap(target.level) : G.BUILDING_CAP
    target.garrison = Math.min(cap, target.garrison + m.units)
    return
  }
  // Бой
  const atkSkin = G.skinById(p.skin)
  const defResearch = target.owner ? g.players.find((x) => x.id === target.owner)?.research ?? 0 : 0
  const isTower = m.toKind === 'tower'
  const r = G.resolveCombat(
    m.units,
    p.research,
    {
      radio: countOwned(g, p.id, 'radio') > 0,
      eventWar: g.event?.kind === 'war',
      skinDamage: atkSkin.perkDamage ?? 0,
    },
    target.garrison,
    isTower ? target.level : 1,
    defResearch,
    { depot: !isTower && (target as Building).type === 'depot' ? true : countOwned(g, target.owner ?? '', 'depot') > 0 }
  )
  const labelName = isTower ? `№${target.id}` : G.BUILDING_NAMES[(target as Building).type]
  if (r.captured) {
    const prevOwner = target.owner
    target.owner = p.id
    target.garrison = r.survivors
    if (isTower) p.stats.captures++
    else p.stats.captures++
    const own = towersOf(g, p.id).length
    if (prevOwner) {
      const prev = g.players.find((x) => x.id === prevOwner)
      pushEvent(g, `⚔ ${p.name} захватил ${labelName} у ${prev?.name ?? '?'}`, p.color)
    } else {
      pushEvent(g, `🏴 ${p.name} захватил ${labelName}`, p.color)
    }
    if (own >= 8) pushEvent(g, `👑 ${p.name} контролирует ${own} башен!`, p.color)
  } else {
    target.garrison = r.defLeft
    if (r.defLeft === 0 && target.owner === null) {
      // Нейтральная цель обезлюдела — захват без боя
      target.owner = p.id
      target.garrison = 1
      p.stats.captures++
      pushEvent(g, `🏴 ${p.name} занял ${labelName}`, p.color)
    } else {
      pushEvent(g, `🛡 Атака ${p.name} на ${labelName} отбита`, g.players[m.seat]?.color ?? null)
    }
  }
}

function doHire(g: Game, p: Player, towerId: number, packs: number): { ok: boolean; error?: string } {
  if (p.eliminated) return { ok: false, error: 'Вы выбыли' }
  const t = g.towers.find((x) => x.id === towerId && x.owner === p.id)
  if (!t) return { ok: false, error: 'Это не ваша башня' }
  const cap = G.towerCap(t.level)
  const free = Math.max(0, Math.floor(cap - t.garrison))
  const count = Math.min(G.HIRE_PACK * packs, free)
  if (count <= 0) return { ok: false, error: 'Гарнизон полон' }
  const cost = G.hireCost(count)
  if (p.res.gold < cost) return { ok: false, error: `Нужно ${cost} золота` }
  p.res.gold -= cost
  t.garrison += count
  return { ok: true }
}

function doUpgradeTower(g: Game, p: Player, towerId: number): { ok: boolean; error?: string } {
  if (p.eliminated) return { ok: false, error: 'Вы выбыли' }
  const t = g.towers.find((x) => x.id === towerId && x.owner === p.id)
  if (!t) return { ok: false, error: 'Это не ваша башня' }
  if (t.level >= G.TOWER_MAX_LEVEL) return { ok: false, error: 'Максимальный уровень' }
  const cost = G.towerUpgradeCost(t.level + 1)
  const mult = eventCostMult(g)
  const gold = Math.round(cost.gold * mult)
  const wood = Math.round(cost.wood * mult)
  if (p.res.gold < gold) return { ok: false, error: `Нужно ${gold} золота` }
  if (p.res.wood < wood) return { ok: false, error: `Нужно ${wood} дерева` }
  p.res.gold -= gold
  p.res.wood -= wood
  t.level++
  pushEvent(g, `🔧 ${p.name}: башня №${t.id} улучшена до ур. ${t.level}`, p.color)
  return { ok: true }
}

function doUpgradeBuilding(g: Game, p: Player, buildingId: number): { ok: boolean; error?: string } {
  if (p.eliminated) return { ok: false, error: 'Вы выбыли' }
  const b = g.buildings.find((x) => x.id === buildingId && x.owner === p.id)
  if (!b) return { ok: false, error: 'Это не ваше здание' }
  if (b.level >= G.BUILDING_MAX_LEVEL) return { ok: false, error: 'Максимальный уровень' }
  const cost = G.buildingUpgradeCost(b.level + 1)
  const mult = eventCostMult(g)
  const gold = Math.round(cost.gold * mult)
  const wood = Math.round(cost.wood * mult)
  if (p.res.gold < gold) return { ok: false, error: `Нужно ${gold} золота` }
  if (p.res.wood < wood) return { ok: false, error: `Нужно ${wood} дерева` }
  p.res.gold -= gold
  p.res.wood -= wood
  b.level++
  pushEvent(g, `⬆ ${p.name}: ${G.BUILDING_NAMES[b.type]} ур. ${b.level}`, p.color)
  return { ok: true }
}

function doResearch(g: Game, p: Player): { ok: boolean; error?: string } {
  if (p.eliminated) return { ok: false, error: 'Вы выбыли' }
  if (p.research >= G.RESEARCH_MAX_LEVEL) return { ok: false, error: 'Максимальный уровень' }
  const cost = G.researchCost(p.research + 1)
  if (p.res.ideas < cost) return { ok: false, error: `Нужно ${cost} идей` }
  p.res.ideas -= cost
  p.research++
  pushEvent(g, `💡 ${p.name}: армия усилена до ур. ${p.research}`, p.color)
  return { ok: true }
}

// ============================ БОТЫ ============================

function neededFor(g: Game, bot: Player, target: Tower | Building, isTower: boolean): number {
  const defResearch = target.owner ? g.players.find((x) => x.id === target.owner)?.research ?? 0 : 0
  const d = G.defensePower(target.garrison, isTower ? target.level : 1, defResearch, {
    depot: !isTower && (target as Building).type === 'depot',
  })
  const a = G.attackPower(1, bot.research, {
    radio: countOwned(g, bot.id, 'radio') > 0,
    eventWar: g.event?.kind === 'war',
  })
  return Math.ceil(d / a) + 4
}

function botThink(g: Game, p: Player) {
  const t = now()
  if (t < p.botNextThink) return
  p.botNextThink = t + rnd(1500, 2800)

  const mine = towersOf(g, p.id)
  if (mine.length === 0) return
  const early = t - g.createdAt < G.BOT_GRACE_MS

  // Источник: ближайшая к цели самая насиженная башня
  const source = [...mine].sort((a, b) => b.garrison - a.garrison)[0]

  // 1. Свободные здания рядом (приоритет)
  const freeBuildings = g.buildings.filter((b) => !b.owner)
  if (freeBuildings.length > 0 && source.garrison >= 20) {
    const target = freeBuildings.sort(
      (a, b) => G.dist(source.x, source.y, a.x, a.y) - G.dist(source.x, source.y, b.x, b.y)
    )[0]
    const need = neededFor(g, p, target, false)
    if (source.garrison * 0.9 >= need) {
      const send = Math.min(Math.floor(source.garrison * 0.7), Math.max(need, 10))
      doMarch(g, p, source.id, 'building', target.id, send / source.garrison)
      return
    }
  }

  // 2. Свободные башни
  const freeTowers = g.towers.filter((tw) => !tw.owner)
  if (freeTowers.length > 0 && source.garrison >= 25 && (Math.random() < 0.75 || early)) {
    const target = freeTowers.sort(
      (a, b) => G.dist(source.x, source.y, a.x, a.y) - G.dist(source.x, source.y, b.x, b.y)
    )[0]
    const need = neededFor(g, p, target, true)
    if (source.garrison * 0.9 >= need) {
      const send = Math.min(Math.floor(source.garrison * 0.65), Math.max(need, 12))
      doMarch(g, p, source.id, 'tower', target.id, send / source.garrison)
      return
    }
  }

  // 3. Атака вражеских владений (после разгона, с учётом агрессии)
  if (!early) {
    const enemyTargets: { node: Tower | Building; kind: 'tower' | 'building' }[] = [
      ...g.buildings.filter((b) => b.owner && b.owner !== p.id).map((b) => ({ node: b as Tower | Building, kind: 'building' as const })),
      ...g.towers.filter((tw) => tw.owner && tw.owner !== p.id).map((tw) => ({ node: tw, kind: 'tower' as const })),
    ]
    if (enemyTargets.length > 0 && source.garrison >= 30 && Math.random() < 0.6 * p.botAggro) {
      const target = enemyTargets.sort(
        (a, b) => G.dist(source.x, source.y, a.node.x, a.node.y) - G.dist(source.x, source.y, b.node.x, b.node.y)
      )[0]
      const need = neededFor(g, p, target.node, target.kind === 'tower')
      if (source.garrison * 0.85 >= need) {
        const send = Math.min(Math.floor(source.garrison * 0.7), Math.max(need + 5, 15))
        doMarch(g, p, source.id, target.kind, target.node.id, send / source.garrison)
        return
      }
    }
  }

  // 4. Экономика: улучшения
  if (Math.random() < 0.8) {
    for (const b of buildingsOf(g, p.id)) {
      if (b.level < G.BUILDING_MAX_LEVEL) {
        const cost = G.buildingUpgradeCost(b.level + 1)
        const mult = eventCostMult(g)
        if (p.res.gold >= cost.gold * mult + 200 && p.res.wood >= cost.wood * mult + 100) {
          doUpgradeBuilding(g, p, b.id)
          return
        }
      }
    }
  }
  if (Math.random() < 0.5) {
    const upgradable = mine.filter((tw) => tw.level < G.TOWER_MAX_LEVEL)
    if (upgradable.length > 0) {
      const tw = pick(upgradable)
      const cost = G.towerUpgradeCost(tw.level + 1)
      const mult = eventCostMult(g)
      if (p.res.gold >= cost.gold * mult + 200 && p.res.wood >= cost.wood * mult + 100) {
        doUpgradeTower(g, p, tw.id)
        return
      }
    }
  }
  if (Math.random() < 0.4 && p.research < G.RESEARCH_MAX_LEVEL) {
    const c = G.researchCost(p.research + 1)
    if (p.res.ideas >= c + 20) doResearch(g, p)
  }

  // 5. Найм
  if (Math.random() < 0.5 && p.res.gold > 400) {
    doHire(g, p, source.id, 2)
  }
}

// ============================ ИГРОВОЙ ЦИКЛ ============================

const TICK_MS = 200

setInterval(() => {
  const t = now()
  const dt = TICK_MS / 1000
  for (const g of games.values()) {
    if (g.over) continue
    g.tick++

    // Доходы
    for (const p of g.players) {
      if (p.eliminated) continue
      const sk = G.skinById(p.skin)
      const inc = G.computeIncome(g.towers, g.buildings, p.id, sk.perkGold ?? 0, g.event)
      p.res.gold += inc.gold * dt
      p.res.wood += inc.wood * dt
      p.res.ideas += inc.ideas * dt
      p.goldEarned += inc.gold * dt
    }

    // Пополнение гарнизонов
    for (const tw of g.towers) {
      if (!tw.owner) continue
      const sk = skinOf(g, tw.owner)
      const barracks = countOwned(g, tw.owner, 'barracks')
      const cap = G.towerCap(tw.level)
      if (tw.garrison < cap) {
        tw.garrison = Math.min(cap, tw.garrison + G.towerRegen(barracks, sk.perkRegen ?? 0) * dt)
      }
    }
    for (const b of g.buildings) {
      if (!b.owner) continue
      if (b.garrison < G.BUILDING_CAP) b.garrison = Math.min(G.BUILDING_CAP, b.garrison + G.REGEN_BUILDING_PER_S * dt)
    }

    // Нейтральные точки потихоньку восстанавливаются — «бесхозных» на карте не остаётся
    for (const tw of g.towers) {
      if (tw.owner) continue
      if (tw.garrison < tw.baseG) tw.garrison = Math.min(tw.baseG, tw.garrison + G.NEUTRAL_REGEN_PER_S * dt)
    }
    for (const b of g.buildings) {
      if (b.owner) continue
      if (b.garrison < b.baseG) b.garrison = Math.min(b.baseG, b.garrison + G.NEUTRAL_REGEN_PER_S * dt)
    }

    // Марши
    const spd = G.MARCH_SPEED * marchSpeedMult(g)
    for (const m of g.marches) {
      m.progress = Math.min(1, m.progress + (dt * spd) / m.dist)
    }
    const arrived = g.marches.filter((m) => m.progress >= 1)
    if (arrived.length > 0) {
      g.marches = g.marches.filter((m) => m.progress < 1)
      for (const m of arrived) resolveArrival(g, m)
    }

    // События «ВЛАСТЬ …»
    if (g.event && t >= g.event.endsAt) {
      pushEvent(g, `Событие «${g.event.name}» закончилось`, null)
      g.nextEventAt = t + rnd(35_000, 50_000)
      g.event = null
    }
    if (!g.event && t >= g.nextEventAt) {
      const variants = G.EVENT_DEFS.filter((e) => e.kind !== g.lastEventKind)
      const def = pick(variants)
      g.event = { kind: def.kind, name: def.name, desc: def.desc, endsAt: t + G.EVENT_DURATION_MS }
      g.lastEventKind = def.kind
      pushEvent(g, `👑 ${def.name}: ${def.desc}!`, '#fbbf24', true)
    }

    // Боты
    for (const p of g.players) {
      if (p.isBot && !p.eliminated) botThink(g, p)
    }

    // Выбытия и победа
    checkEliminations(g)
    const alive = g.players.filter((p) => !p.eliminated)
    if (alive.length <= 1) {
      finishGame(g, alive[0] ?? null, alive[0] ? `${alive[0].name} — последняя уцелевшая команда!` : 'Все команды выбыли')
    } else if (t >= g.endsAt) {
      const sorted = [...alive].sort(
        (a, b) =>
          G.computeScore(b.goldEarned, b.stats.captures, b.stats.kills) - G.computeScore(a.goldEarned, a.stats.captures, a.stats.kills)
      )
      finishGame(g, sorted[0] ?? null, 'Время вышло — победа по очкам!')
    }

    broadcast(g)
  }
}, TICK_MS)

function finishGame(g: Game, winner: Player | null, reason: string) {
  g.over = true
  g.overAt = now()
  g.winner = winner?.id ?? null
  g.winReason = reason
  pushEvent(g, `🏆 Игра окончена! ${reason}`, winner?.color ?? '#fff', true)

  // Итоговая таблица с наградами (кристаллы начисляет клиент локально)
  const rows = [...g.players]
    .map((p) => ({
      p,
      score: G.computeScore(p.goldEarned, p.stats.captures, p.stats.kills),
    }))
    .sort((a, b) => {
      if (a.p.eliminated !== b.p.eliminated) return a.p.eliminated ? 1 : -1
      return b.score - a.score
    })
    .map((row, i) => {
      const won = g.winner === row.p.id
      const reward = row.p.isBot ? 0 : G.matchReward({ captures: row.p.stats.captures, kills: row.p.stats.kills, score: row.score }, won, !row.p.eliminated)
      return {
        id: row.p.id,
        name: row.p.name,
        seat: row.p.seat,
        color: row.p.color,
        isBot: row.p.isBot,
        score: row.score,
        captures: row.p.stats.captures,
        kills: row.p.stats.kills,
        won,
        reward,
        place: i + 1,
      }
    })
  g.results = rows
  markDirty()
  log(`Матч ${g.id} окончен. Победитель: ${winner?.name ?? '—'}`)
}

// Удаление брошенных матчей: законченные — через 30 с, идущие без людей — через 90 с
setInterval(() => {
  const t = now()
  for (const [id, g] of games) {
    const humans = g.players.filter((p) => !p.isBot)
    const anyOnline = humans.some((p) => {
      const sid = [...socketToPlayer.entries()].find(([, pid]) => pid === p.id)?.[0]
      return p.connected && sid && io.sockets.sockets.has(sid)
    })
    if (anyOnline) {
      g.offlineSince = 0
      continue
    }
    if (g.over) {
      if (t - g.overAt > 30_000) {
        games.delete(id)
        for (const p of g.players) playerToGame.delete(p.id)
        markDirty()
        log(`Матч ${id} удалён (окончен и пуст)`)
      }
      continue
    }
    // Матч продолжается, но людей нет: держим его 90 секунд — вдруг переподключатся
    if (!g.offlineSince) g.offlineSince = t
    if (t - g.offlineSince > 90_000) {
      games.delete(id)
      for (const p of g.players) playerToGame.delete(p.id)
      markDirty()
      log(`Матч ${id} удалён (никто не вернулся за 90с)`)
    }
  }
}, 15000)

// ============================ МАТЧМЕЙКИНГ ============================

/** Очередь делится на комнаты до 4 человек: собралось 2+ — матч стартует сразу,
 *  остальные ждут следующую комнату. Одиночка ждёт до 30 с, затем матч с ботами. */
function emitSearchStatus() {
  const t = now()
  for (const q of searchQueue) {
    io.to(q.sid).emit('search:status', {
      found: searchQueue.length,
      windowRemaining: Math.max(0, q.joinedAt + G.SEARCH_WINDOW_MS - t),
      countdown: null,
    })
  }
}

function startMatchWith(queueSlice: Queued[]) {
  const humans = queueSlice.map((q) => ({ socketId: q.sid, name: q.name, skin: q.skin }))
  const { game: g, auth } = createGame(humans, 'matchmaking')
  for (const q of queueSlice) {
    const a = auth.get(q.sid)
    io.to(q.sid).emit('match:start', { gameId: g.id, ...(a ?? {}) })
  }
  broadcast(g)
  log(`Матч ${g.id} стартовал: ${queueSlice.map((q) => q.name).join(', ')}`)
}

function startSoloWithBots(socket: Socket) {
  const d = (socket.data ?? {}) as { playerName?: string; skin?: string }
  const { game: g, auth } = createGame([{ socketId: socket.id, name: cleanName(d.playerName), skin: d.skin }], 'matchmaking')
  const a = auth.get(socket.id)
  socket.emit('match:start', { gameId: g.id, ...(a ?? {}) })
  broadcast(g)
}

setInterval(() => {
  // Чистим очередь: отключившиеся и уже играющие
  searchQueue = searchQueue.filter((q) => {
    if (!io.sockets.sockets.has(q.sid)) return false
    if (socketToPlayer.has(q.sid)) return false
    return true
  })
  const t = now()
  // Комнаты: пока в очереди есть 2+, берём до 4 человек и стартуем матч
  while (searchQueue.length >= 2) {
    const slice = searchQueue.splice(0, G.MAX_PLAYERS)
    startMatchWith(slice)
  }
  // Одиночка: ждём до конца своего окна 30 с, потом матч с ботами
  if (searchQueue.length === 1) {
    const q = searchQueue[0]
    if (t >= q.joinedAt + G.SEARCH_WINDOW_MS) {
      searchQueue = []
      const sock = io.sockets.sockets.get(q.sid)
      if (sock) startSoloWithBots(sock)
    } else {
      emitSearchStatus()
    }
  }
}, 300)

// ============================ ПРИВАТНЫЕ КОМНАТЫ ============================

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function makeCode(): string {
  for (;;) {
    let c = ''
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    if (!rooms.has(c)) return c
  }
}

function roomState(r: Room) {
  return {
    code: r.code,
    isHost: r.hostSocketId,
    members: r.members,
    host: r.hostSocketId,
  }
}

function broadcastRoom(r: Room) {
  io.to(`room:${r.code}`).emit('room:state', roomState(r))
}

// ============================ SOCKET.IO ============================

io.on('connection', (socket) => {
  log(`Подключение: ${socket.id}`)

  const getPlayer = (): { game: Game; player: Player } | null => {
    const pid = socketToPlayer.get(socket.id)
    if (!pid) return null
    const gid = playerToGame.get(pid)
    if (!gid) return null
    const g = games.get(gid)
    if (!g) return null
    const p = g.players.find((x) => x.id === pid)
    if (!p) return null
    return { game: g, player: p }
  }

  socket.on('findGame', (data: { name?: string; skin?: string }) => {
    if (getPlayer()) return socket.emit('error:msg', { message: 'Вы уже в игре' })
    const name = cleanName(data?.name)
    ;(socket.data as { playerName?: string; skin?: string }).playerName = name
    ;(socket.data as { skin?: string }).skin = typeof data?.skin === 'string' ? data.skin : 'standard'
    if (!searchQueue.some((q) => q.sid === socket.id)) {
      searchQueue.push({
        sid: socket.id,
        name,
        skin: (socket.data as { skin?: string }).skin ?? 'standard',
        joinedAt: now(),
      })
    }
    socket.emit('search:started', {})
    emitSearchStatus()
    log(`Поиск игры: ${name} (${socket.id}), в очереди: ${searchQueue.length}`)
  })

  socket.on('cancelSearch', () => {
    searchQueue = searchQueue.filter((q) => q.sid !== socket.id)
    socket.emit('search:cancelled', {})
  })

  socket.on('playWithBots', (data: { name?: string; skin?: string }) => {
    if (getPlayer()) return socket.emit('error:msg', { message: 'Вы уже в игре' })
    const name = cleanName(data?.name)
    ;(socket.data as { playerName?: string; skin?: string }).playerName = name
    ;(socket.data as { skin?: string }).skin = typeof data?.skin === 'string' ? data.skin : 'standard'
    startSoloWithBots(socket)
  })

  socket.on('room:create', (data: { name?: string; skin?: string }) => {
    if (getPlayer()) return socket.emit('error:msg', { message: 'Вы уже в игре' })
    const name = cleanName(data?.name)
    const skin = typeof data?.skin === 'string' ? data.skin : 'standard'
    ;(socket.data as { playerName?: string; skin?: string }).playerName = name
    ;(socket.data as { skin?: string }).skin = skin
    const r: Room = { code: makeCode(), hostSocketId: socket.id, members: [{ socketId: socket.id, name, isBot: false, skin }] }
    rooms.set(r.code, r)
    socket.join(`room:${r.code}`)
    socket.emit('room:joined', { code: r.code })
    broadcastRoom(r)
    log(`Комната ${r.code} создана (${name})`)
  })

  socket.on('room:join', (data: { name?: string; code?: string; skin?: string }) => {
    if (getPlayer()) return socket.emit('error:msg', { message: 'Вы уже в игре' })
    const code = (data?.code ?? '').toUpperCase().trim()
    const r = rooms.get(code)
    if (!r) return socket.emit('error:msg', { message: 'Комната не найдена' })
    if (r.members.length >= G.MAX_PLAYERS) return socket.emit('error:msg', { message: 'Комната заполнена' })
    const name = cleanName(data?.name)
    const skin = typeof data?.skin === 'string' ? data.skin : 'standard'
    ;(socket.data as { playerName?: string; skin?: string }).playerName = name
    ;(socket.data as { skin?: string }).skin = skin
    r.members.push({ socketId: socket.id, name, isBot: false, skin })
    socket.join(`room:${r.code}`)
    socket.emit('room:joined', { code: r.code })
    broadcastRoom(r)
    log(`${name} вошёл в комнату ${r.code}`)
  })

  socket.on('room:addBot', () => {
    const r = [...rooms.values()].find((x) => x.members.some((m) => m.socketId === socket.id))
    if (!r || r.hostSocketId !== socket.id) return
    if (r.members.length >= G.MAX_PLAYERS) return socket.emit('error:msg', { message: 'Комната заполнена' })
    const used = new Set(r.members.map((m) => m.name))
    const name = G.BOT_NAMES.find((n) => !used.has(n)) ?? `Бот ${uid().slice(0, 4)}`
    r.members.push({ socketId: '', name, isBot: true })
    broadcastRoom(r)
  })

  socket.on('room:removeMember', (data: { socketId: string }) => {
    const r = [...rooms.values()].find((x) => x.members.some((m) => m.socketId === socket.id))
    if (!r || r.hostSocketId !== socket.id) return
    if (data.socketId === r.hostSocketId) return
    r.members = r.members.filter((m) => m.socketId !== data.socketId)
    broadcastRoom(r)
  })

  socket.on('room:leave', () => {
    const r = [...rooms.values()].find((x) => x.members.some((m) => m.socketId === socket.id))
    if (!r) return
    r.members = r.members.filter((m) => m.socketId !== socket.id)
    socket.leave(`room:${r.code}`)
    if (r.members.length === 0) {
      rooms.delete(r.code)
      log(`Комната ${r.code} закрыта`)
    } else {
      if (r.hostSocketId === socket.id) r.hostSocketId = r.members[0].socketId
      broadcastRoom(r)
    }
  })

  socket.on('room:start', () => {
    const r = [...rooms.values()].find((x) => x.members.some((m) => m.socketId === socket.id))
    if (!r || r.hostSocketId !== socket.id) return
    const humans = r.members.filter((m) => !m.isBot).map((m) => ({ socketId: m.socketId, name: m.name, skin: m.skin }))
    const bots = r.members.filter((m) => m.isBot).map((m) => ({ socketId: null as string | null, name: m.name }))
    const all = [...humans, ...bots]
    if (humans.length === 0) return
    rooms.delete(r.code)
    const { game: g, auth } = createGame(all, 'room')
    for (const m of r.members) {
      if (!m.socketId) continue
      const a = auth.get(m.socketId)
      io.to(m.socketId).emit('match:start', { gameId: g.id, ...(a ?? {}) })
    }
    broadcast(g)
    log(`Комната ${r.code} стартовала матч ${g.id}`)
  })

  socket.on('rejoin', (data: { playerId: string; key: string }) => {
    const { playerId, key } = data ?? {}
    if (!playerId || !key) return
    const gid = playerToGame.get(playerId)
    if (!gid) return socket.emit('rejoin:fail', {})
    const g = games.get(gid)
    const p = g?.players.find((x) => x.id === playerId)
    if (!g || !p || p.key !== key) return socket.emit('rejoin:fail', {})
    socketToPlayer.set(socket.id, p.id)
    socket.join(g.id)
    p.connected = true
    socket.emit('rejoin:ok', { gameId: g.id, playerId: p.id, seat: p.seat })
    pushEvent(g, `🔌 ${p.name} вернулся в игру`, p.color)
    broadcast(g)
    log(`Переподключение: ${p.name} → ${g.id}`)
  })

  socket.on('game:action', (data: { type: string; payload?: Record<string, unknown> }) => {
    const ctx = getPlayer()
    if (!ctx) return socket.emit('error:msg', { message: 'Вы не в игре' })
    const { game: g, player: p } = ctx
    if (g.over) return
    const payload = data?.payload ?? {}
    let res: { ok: boolean; error?: string } = { ok: false, error: 'Неизвестное действие' }

    switch (data?.type) {
      case 'march':
        res = doMarch(
          g,
          p,
          Math.floor(Number(payload.fromId) || 0),
          payload.toKind === 'building' ? 'building' : 'tower',
          Math.floor(Number(payload.toId) || 0),
          Number(payload.share) || 0.5
        )
        break
      case 'hire':
        res = doHire(g, p, Math.floor(Number(payload.towerId) || 0), Math.max(1, Math.min(4, Math.floor(Number(payload.packs) || 1))))
        break
      case 'upgradeTower':
        res = doUpgradeTower(g, p, Math.floor(Number(payload.towerId) || 0))
        break
      case 'upgradeBuilding':
        res = doUpgradeBuilding(g, p, Math.floor(Number(payload.buildingId) || 0))
        break
      case 'research':
        res = doResearch(g, p)
        break
    }
    if (!res.ok) socket.emit('error:msg', { message: res.error ?? 'Нельзя выполнить' })
    broadcast(g)
  })

  socket.on('game:leave', () => {
    const ctx = getPlayer()
    if (!ctx) return
    const { game: g, player: p } = ctx
    socket.leave(g.id)
    socketToPlayer.delete(socket.id)
    p.connected = false
    if (!g.over) {
      p.isBot = true
      p.botNextThink = 0
      pushEvent(g, `🤖 ${p.name} покинул игру — командует ИИ`, p.color)
    }
    broadcast(g)
  })

  // ============================ ПРОМОКОДЫ И АДМИНКА ============================
  // Коды проверяются на сервере, в коде хранятся в обфусцированном виде.
  // Один код — одна активация на сокет-сессию (плюс локальный контроль на устройстве).
  const redeemedNow = new Set<string>()

  socket.on('promo:redeem', (data: { code?: string }, ack?: (r: unknown) => void) => {
    const reply = (r: unknown) => {
      if (typeof ack === 'function') ack(r)
    }
    const raw = typeof data?.code === 'string' ? data.code.trim() : ''
    const code = raw.toUpperCase()
    if (!code) return reply({ ok: false, error: 'Введите код' })
    if (redeemedNow.has(code)) return reply({ ok: false, error: 'Этот код уже активирован в этой сессии' })

    // Админ-код → ключ админ-действий + лисья база (регистр не важен)
    if (code === ADMIN_CODE_STR.toUpperCase()) {
      redeemedNow.add(code)
      log(`Выдан доступ администратора`)
      return reply({ ok: true, admin: true, adminKey: ADMIN_KEY, label: 'Лисий проход открыт 🦊' })
    }

    const def = PROMO_TABLE[code]
    if (!def) return reply({ ok: false, error: 'Промокод не найден или истёк' })
    redeemedNow.add(code)
    log(`Промокод активирован`)
    return reply({ ok: true, crystals: def.crystals, label: def.label })
  })

  socket.on('admin:action', (data: { key?: string; type?: string }, ack?: (r: unknown) => void) => {
    const reply = (r: unknown) => {
      if (typeof ack === 'function') ack(r)
    }
    if (!data || data.key !== ADMIN_KEY) return reply({ ok: false, error: 'Доступ запрещён' })
    const ctx = getPlayer()
    if (!ctx) return reply({ ok: false, error: 'Вы не в игре' })
    const { game: g, player: p } = ctx
    if (g.over) return reply({ ok: false, error: 'Матч окончен' })
    switch (data.type) {
      case 'res':
        p.res.gold += 1500
        p.res.wood += 800
        p.res.ideas += 150
        pushEvent(g, `🦊 ${p.name}: припасы лисьей казны`, p.color)
        break
      case 'units': {
        let n = 0
        for (const tw of towersOf(g, p.id)) {
          tw.garrison = G.towerCap(tw.level)
          n++
        }
        for (const b of buildingsOf(g, p.id)) b.garrison = G.BUILDING_CAP
        pushEvent(g, `🦊 ${p.name}: лисьи дружины заполнили опорные точки (${n})`, p.color)
        break
      }
      case 'weaken': {
        let touched = 0
        for (const tw of g.towers) {
          if (tw.owner && tw.owner !== p.id) {
            tw.garrison = Math.floor(tw.garrison / 2)
            touched++
          }
        }
        for (const b of g.buildings) {
          if (b.owner && b.owner !== p.id) {
            b.garrison = Math.floor(b.garrison / 2)
            touched++
          }
        }
        pushEvent(g, `🦊 ${p.name}: лисий шёпот ослабил врагов (${touched})`, p.color)
        break
      }
      case 'treasure':
        p.res.gold += 5000
        pushEvent(g, `🦊 ${p.name}: лисья сокровищница раскрыта!`, p.color)
        break
      default:
        return reply({ ok: false, error: 'Неизвестное действие' })
    }
    broadcast(g)
    return reply({ ok: true })
  })

  socket.on('disconnect', () => {
    log(`Отключение: ${socket.id}`)
    // Матчмейкинг
    searchQueue = searchQueue.filter((q) => q.sid !== socket.id)
    // Комната
    const r = [...rooms.values()].find((x) => x.members.some((m) => m.socketId === socket.id))
    if (r) {
      r.members = r.members.filter((m) => m.socketId !== socket.id)
      if (r.members.length === 0) rooms.delete(r.code)
      else {
        if (r.hostSocketId === socket.id) r.hostSocketId = r.members[0].socketId
        broadcastRoom(r)
      }
    }
    // Игра: управление боту
    const pid = socketToPlayer.get(socket.id)
    if (pid) {
      socketToPlayer.delete(socket.id)
      const gid = playerToGame.get(pid)
      const g = gid ? games.get(gid) : null
      const p = g?.players.find((x) => x.id === pid)
      if (g && p && !g.over) {
        p.connected = false
        p.isBot = true
        p.botNextThink = 0
        pushEvent(g, `⚠ ${p.name} отключился — командует ИИ`, p.color)
        broadcast(g)
      }
    }
  })

  socket.on('error', (e) => log(`Ошибка сокета ${socket.id}:`, e))
})

// Восстанавливаем матчи прошлого запуска, затем открываем порт
loadSnapshot()
setInterval(saveSnapshot, 5000)

httpServer.on('error', (e) => {
  console.error('[game] Ошибка сервера (возможно, уже запущен в другом процессе):', e)
  process.exit(0)
})

httpServer.listen(Number(process.env.GAME_PORT || 3003), () => log(`Игровой сервер запущен на порту ${process.env.GAME_PORT || 3003}`))

process.on('SIGTERM', () => {
  saveSnapshot()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
})
process.on('SIGINT', () => {
  saveSnapshot()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
})
