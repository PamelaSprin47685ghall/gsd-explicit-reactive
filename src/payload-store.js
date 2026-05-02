// Payload store for DAG execution bridge

export const payloadStore = {
  _map: new Map(),
  _ttl: 30000,
  set(key, value, ttl) {
    const expiresIn = ttl ?? this._ttl;
    const old = this._map.get(key);
    if (old?.timer) clearTimeout(old.timer);
    let timer;
    if (expiresIn > 0) {
      timer = setTimeout(() => this._map.delete(key), expiresIn);
      timer.unref?.();
    }
    this._map.set(key, { value, createdAt: Date.now(), ttl: expiresIn, timer });
  },
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  },
  delete(key) {
    const old = this._map.get(key);
    if (old?.timer) clearTimeout(old.timer);
    this._map.delete(key);
  },
  has(key) {
    return this.get(key) !== undefined;
  },
};
