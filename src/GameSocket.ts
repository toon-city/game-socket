import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import {
  StompDest,
  roomTopic,
  UserJoinedPayload,
  UserLeftPayload,
  RemoteAvatarMovePayload,
  RemoteAvatarSayPayload,
  RemoteFurnitureMovePayload,
  RemoteFurniturePlacePayload,
  RemoteFurnitureRemovePayload,
  RemoteFurnitureRotatePayload,
  RemoteChatMessagePayload,
  AvatarAppearancePayload,
  RoomState,
  RoomErrorPayload,
  FurniturePlacePayload,
  FurnitureMovePayload,
  FurnitureRotatePayload,
  FurnitureRemovePayload,
} from '@toon-live/game-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

type EventMap = {
  connected: [];
  disconnected: [];
  roomState: [state: RoomState];
  roomError: [error: RoomErrorPayload];
  kicked: [message: string];
  userJoined: [payload: UserJoinedPayload];
  userLeft: [payload: UserLeftPayload];
  remoteAvatarMove: [payload: RemoteAvatarMovePayload];
  remoteAvatarSay: [payload: RemoteAvatarSayPayload];
  avatarAppearance: [payload: AvatarAppearancePayload];
  remoteFurnitureMove: [payload: RemoteFurnitureMovePayload];
  remoteFurniturePlace: [payload: RemoteFurniturePlacePayload];
  remoteFurnitureRemove: [payload: RemoteFurnitureRemovePayload];
  remoteFurnitureRotate: [payload: RemoteFurnitureRotatePayload];
  remoteChatMessage: [payload: RemoteChatMessagePayload];
};

type Listener<K extends keyof EventMap> = (...args: EventMap[K]) => void;

export interface GameSocketOptions {
  serverUrl: string;
  /** JWT token string *or* a getter called before each (re)connect attempt. */
  token: string | (() => string);
  /** Throttle interval (ms) for avatar_move events. Default: 50 */
  moveThrottleMs?: number;
}

// ─── GameSocket ────────────────────────────────────────────────────────────────

/**
 * Thin adapter bridging STOMP-over-WebSocket and the rest of the application.
 *
 * Usage:
 * ```ts
 * const gs = new GameSocket({ serverUrl: 'http://localhost:8081', token });
 * gs.on('roomState', (state) => { … });
 * gs.connect();
 * gs.joinRoom('jardin');
 * // In avatar move callback from GameCore:
 * gs.sendAvatarMove('jardin', x, y);
 * ```
 */
export class GameSocket {
  private client: Client | null = null;
  private listeners = new Map<string, Set<Listener<any>>>();
  private readonly opts: Required<GameSocketOptions>;

  /** Active STOMP subscriptions per room, keyed by roomId */
  private roomSubscriptions = new Map<string, StompSubscription[]>();

  /** Global subscriptions (user queue) */
  private globalSubs: StompSubscription[] = [];

  // Throttle state for avatar move
  private lastMoveAt = 0;
  private pendingMove: { roomId: string; x: number; y: number; direction: number } | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GameSocketOptions) {
    this.opts = { moveThrottleMs: 50, ...opts };
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  connect(): void {
    if (this.client?.connected) return;

    // WebSocket URL: convert http(s):// → ws(s)://
    const wsUrl = this.opts.serverUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');

    this.client = new Client({
      brokerURL: `${wsUrl}/ws`,
      reconnectDelay: 5000,
      beforeConnect: async () => {
        // Refresh headers before every (re)connect so a renewed token is used.
        const tok = typeof this.opts.token === 'function'
          ? this.opts.token()
          : this.opts.token;
        this.client!.connectHeaders = { Authorization: `Bearer ${tok}` };
      },
      onConnect: () => {
        this._subscribeGlobal();
        this.emit('connected');
      },
      onDisconnect: () => {
        this.emit('disconnected');
      },
      onWebSocketError: () => {
        // WebSocket-level failure (server unreachable, network error…).
        // Treated identically to a disconnection so consumers can redirect.
        this.emit('disconnected');
      },
      onStompError: (frame) => {
        const message = frame.headers['message'] ?? 'STOMP error';
        // Spring wraps interceptor rejections with this generic message.
        // The real cause is always an invalid/expired JWT on the CONNECT frame.
        const isAuthError = message.includes('clientInboundChannel') ||
            message.toLowerCase().includes('jwt') ||
            message.toLowerCase().includes('token') ||
            message.toLowerCase().includes('authorization');
        this.emit('roomError', {
          code: isAuthError ? 'INVALID_TOKEN' : 'INTERNAL',
          message,
        });
        if (isAuthError) {
          // Do not reconnect — the token needs to be refreshed first.
          this.client?.deactivate();
        }
      },
    });

    this.client.activate();
  }

  disconnect(): void {
    this.client?.deactivate();
    this.client = null;
    this.roomSubscriptions.clear();
    this.globalSubs = [];
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  // ── Room ─────────────────────────────────────────────────────────────────

  joinRoom(roomId: string, direction = 1, x = 300, y = 300): void {
    if (!this.client?.connected) return;

    // Subscribe to all room-scoped topics
    const subs: StompSubscription[] = [
      this._sub(roomTopic(roomId, StompDest.TOPIC_JOINED), (msg) =>
        this.emit('userJoined', this._parse<UserJoinedPayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_LEFT), (msg) =>
        this.emit('userLeft', this._parse<UserLeftPayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_AVATAR_MOVE), (msg) =>
        this.emit('remoteAvatarMove', this._parse<RemoteAvatarMovePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_AVATAR_SAY), (msg) =>
        this.emit('remoteAvatarSay', this._parse<RemoteAvatarSayPayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_FURNITURE_MOVE), (msg) =>
        this.emit('remoteFurnitureMove', this._parse<RemoteFurnitureMovePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_FURNITURE_PLACE), (msg) =>
        this.emit('remoteFurniturePlace', this._parse<RemoteFurniturePlacePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_FURNITURE_REMOVE), (msg) =>
        this.emit('remoteFurnitureRemove', this._parse<RemoteFurnitureRemovePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_FURNITURE_ROTATE), (msg) =>
        this.emit('remoteFurnitureRotate', this._parse<RemoteFurnitureRotatePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_AVATAR_APPEARANCE), (msg) =>
        this.emit('avatarAppearance', this._parse<AvatarAppearancePayload>(msg))),

      this._sub(roomTopic(roomId, StompDest.TOPIC_CHAT), (msg) =>
        this.emit('remoteChatMessage', this._parse<RemoteChatMessagePayload>(msg))),
    ];

    this.roomSubscriptions.set(roomId, subs);

    // Notify server
    this.client.publish({
      destination: StompDest.JOIN_ROOM,
      body: JSON.stringify({ roomId, direction, x, y }),
    });
  }

  leaveRoom(roomId: string): void {
    // Unsubscribe from room topics
    this.roomSubscriptions.get(roomId)?.forEach((s) => s.unsubscribe());
    this.roomSubscriptions.delete(roomId);

    // Notify server
    this.client?.publish({
      destination: StompDest.LEAVE_ROOM,
      body: JSON.stringify({ roomId }),
    });
  }

  // ── Avatar ───────────────────────────────────────────────────────────────

  /**
   * Throttled avatar move — at most one packet per `moveThrottleMs`.
   * The last position during the throttle window is always flushed.
   */
  sendAvatarMove(roomId: string, x: number, y: number, direction: number): void {
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;

    if (elapsed >= this.opts.moveThrottleMs) {
      this.lastMoveAt = now;
      this._publish(StompDest.AVATAR_MOVE, { roomId, x, y, direction });
    } else {
      this.pendingMove = { roomId, x, y, direction };
      if (!this.moveTimer) {
        this.moveTimer = setTimeout(() => {
          this.moveTimer = null;
          if (this.pendingMove) {
            const { roomId: rid, x: px, y: py, direction: pd } = this.pendingMove;
            this.pendingMove = null;
            this.lastMoveAt = Date.now();
            this._publish(StompDest.AVATAR_MOVE, { roomId: rid, x: px, y: py, direction: pd });
          }
        }, this.opts.moveThrottleMs - elapsed);
      }
    }
  }

  sendAvatarSay(roomId: string, text: string): void {
    this._publish(StompDest.AVATAR_SAY, { roomId, text });
  }

  /** Demande au serveur de re-charger les vêtements équipés depuis la DB et de les diffuser. */
  sendClothingRefresh(roomId: string): void {
    this._publish(StompDest.CLOTHING_REFRESH, { roomId });
  }

  // ── Furniture ────────────────────────────────────────────────────────────

  sendFurniturePlace(roomId: string, payload: FurniturePlacePayload): void {
    this._publish(StompDest.FURNITURE_PLACE, { roomId, ...payload });
  }

  sendFurnitureMove(roomId: string, payload: FurnitureMovePayload): void {
    this._publish(StompDest.FURNITURE_MOVE, { roomId, ...payload });
  }

  sendFurnitureRotate(roomId: string, payload: FurnitureRotatePayload): void {
    this._publish(StompDest.FURNITURE_ROTATE, { roomId, ...payload });
  }

  sendFurnitureRemove(roomId: string, payload: FurnitureRemovePayload): void {
    this._publish(StompDest.FURNITURE_REMOVE, { roomId, ...payload });
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  sendChatMessage(roomId: string, text: string): void {
    this._publish(StompDest.CHAT_MESSAGE, { roomId, text });
  }

  // ── Event bus ────────────────────────────────────────────────────────────

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as Listener<any>);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as Listener<any>);
  }

  private emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as Function)(...args));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Subscribe to global per-user destinations (ROOM_STATE, QUEUE_ERROR). */
  private _subscribeGlobal(): void {
    this.globalSubs = [
      this._sub(StompDest.QUEUE_STATE, (msg) =>
        this.emit('roomState', this._parse<RoomState>(msg))),

      this._sub(StompDest.QUEUE_ERROR, (msg) =>
        this.emit('roomError', this._parse<RoomErrorPayload>(msg))),

      this._sub(StompDest.QUEUE_KICKED, (msg) => {
        const payload = this._parse<{ message?: string }>(msg);
        this.emit('kicked', payload.message ?? 'Vous avez été déconnecté.');
      }),
    ];
  }

  private _sub(dest: string, handler: (msg: IMessage) => void): StompSubscription {
    return this.client!.subscribe(dest, handler);
  }

  private _publish(dest: string, body: object): void {
    this.client?.publish({ destination: dest, body: JSON.stringify(body) });
  }

  private _parse<T>(msg: IMessage): T {
    return JSON.parse(msg.body) as T;
  }
}
