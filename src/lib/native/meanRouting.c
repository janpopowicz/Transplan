// Freestanding, deterministic WebAssembly kernel. All routing uses f64 minutes.
// No libc, filesystem, threads, clock, or network imports; only linear memory.
typedef unsigned int u32;
typedef unsigned char u8;
typedef int i32;
extern u8 __heap_base;
static u32 arena;
void *memcpy(void *dst, const void *src, unsigned long size) {
  u8 *d = dst; const u8 *s = src; for (unsigned long i = 0; i < size; i++) d[i] = s[i]; return dst;
}
void *memset(void *dst, int value, unsigned long size) {
  u8 *d = dst; for (unsigned long i = 0; i < size; i++) d[i] = value; return dst;
}
u32 allocate(u32 bytes) {
  if (!arena) arena = (u32)&__heap_base;
  u32 start = (arena + 7) & ~7u;
  u32 end = start + bytes;
  if (end < start) __builtin_trap();
  u32 pages = __builtin_wasm_memory_size(0), need = (end + 65535u) / 65536u;
  if (need > pages && __builtin_wasm_memory_grow(0, need - pages) == (unsigned long)-1) __builtin_trap();
  arena = end; return start;
}
typedef struct {
  u32 count, *walk_offsets, *walk_to; double *walk_cost;
  u32 *transit_offsets, *transit_to; double *transit_cost, *headway, *phase;
  u32 boarding_count, *board_from, *board_to; double *board_phase, *board_headway;
  double *walking, *arrivals, *means;
  i32 *heads, *previous; u8 *samples; double *values; u32 events, event_capacity;
  u32 *heap_nodes, heap_size, heap_capacity; double *heap_times;
  u32 original_count, *originals, chain_count, *chain_a, *chain_b, *chain_offsets, *chain_nodes;
  double *chain_length, *chain_distances; u8 *chain_flags; double *bucket_sum, *bucket_count;
  u32 tree_count, *tree_nodes, *tree_parents; double *tree_minutes, *full_times;

} Solver;
static void grow_heap(Solver *s) {
  u32 cap = s->heap_capacity ? s->heap_capacity * 2 : 4096;
  u32 *nodes = (u32*)allocate(cap * sizeof(u32)); double *times = (double*)allocate(cap * sizeof(double));
  if (s->heap_size) { memcpy(nodes, s->heap_nodes, s->heap_size * sizeof(u32)); memcpy(times, s->heap_times, s->heap_size * sizeof(double)); }
  s->heap_nodes = nodes; s->heap_times = times; s->heap_capacity = cap;
}
static void push(Solver *s, u32 node, double time) {
  if (s->heap_size == s->heap_capacity) grow_heap(s);
  u32 i = s->heap_size++;
  while (i) {
    u32 parent = (i - 1) >> 1;
    if (s->heap_times[parent] <= time) break;
    s->heap_nodes[i] = s->heap_nodes[parent]; s->heap_times[i] = s->heap_times[parent]; i = parent;
  }
  s->heap_nodes[i] = node; s->heap_times[i] = time;
}
static u32 pop(Solver *s, double *out_time) {
  u32 result = s->heap_nodes[0]; *out_time = s->heap_times[0];
  u32 node = s->heap_nodes[--s->heap_size]; double time = s->heap_times[s->heap_size];
  if (!s->heap_size) return result;
  u32 i = 0;
  while (i * 2 + 1 < s->heap_size) {
    u32 child = i * 2 + 1;
    if (child + 1 < s->heap_size && s->heap_times[child + 1] < s->heap_times[child]) child++;
    if (s->heap_times[child] >= time) break;
    s->heap_nodes[i] = s->heap_nodes[child]; s->heap_times[i] = s->heap_times[child]; i = child;
  }
  s->heap_nodes[i] = node; s->heap_times[i] = time; return result;
}
static void record(Solver *s, u32 node, u32 sample, double value) {
  i32 head = s->heads[node];
  if (head >= 0 && s->samples[head] == sample) { s->values[head] = value; return; }
  if (s->events == s->event_capacity) {
    u32 cap = s->event_capacity ? s->event_capacity * 2 : 16384;
    i32 *previous = (i32*)allocate(cap * sizeof(i32)); u8 *samples = (u8*)allocate(cap); double *values = (double*)allocate(cap * sizeof(double));
    if (s->events) { memcpy(previous, s->previous, s->events * sizeof(i32)); memcpy(samples, s->samples, s->events); memcpy(values, s->values, s->events * sizeof(double)); }
    s->previous = previous; s->samples = samples; s->values = values; s->event_capacity = cap;
  }
  u32 at = s->events++;
  s->previous[at] = head; s->samples[at] = sample; s->values[at] = value; s->heads[node] = at;
}
static double departure(double time, double phase, double headway) {
  return phase + __builtin_ceil((time - phase - 1e-9) / headway) * headway;
}
static void relax(Solver *s, u32 to, double time, double start, u32 sample) {
  if (time >= start + s->walking[to] - 1e-9 || time >= s->arrivals[to] - 1e-9) return;
  s->arrivals[to] = time; push(s, to, time); record(s, to, sample, time);
}
static double sum_durations(double walking, double arrival, u32 lo, u32 hi) {
  u32 count = hi - lo + 1;
  if (!__builtin_isfinite(arrival)) return count * walking;
  if (!__builtin_isfinite(walking)) return count * (arrival - 0.25) - 0.25 * count * (lo + hi);
  double split = __builtin_floor(2 * (arrival - 0.25 - walking));
  i32 last = split < (i32)lo - 1 ? (i32)lo - 1 : split > hi ? (i32)hi : (i32)split;
  u32 walk_count = last - (i32)lo + 1, transit_count = count - walk_count;
  return walk_count * walking + transit_count * (arrival - 0.25) - 0.25 * transit_count * (last + 1 + hi);
}
u32 create_solver(u32 count, u32 wo, u32 wt, u32 wc, u32 to, u32 tt, u32 tc, u32 headway, u32 phase,
  u32 boarding_count, u32 bf, u32 bt, u32 bp, u32 bh) {
  Solver *s = (Solver*)allocate(sizeof(Solver)); memset(s, 0, sizeof(Solver));
  s->count = count; s->walk_offsets = (u32*)wo; s->walk_to = (u32*)wt; s->walk_cost = (double*)wc;
  s->transit_offsets = (u32*)to; s->transit_to = (u32*)tt; s->transit_cost = (double*)tc; s->headway = (double*)headway; s->phase = (double*)phase;
  s->boarding_count = boarding_count; s->board_from = (u32*)bf; s->board_to = (u32*)bt; s->board_phase = (double*)bp; s->board_headway = (double*)bh;
  s->walking = (double*)allocate(count * sizeof(double)); s->arrivals = (double*)allocate(count * sizeof(double));
  s->means = (double*)allocate(count * sizeof(double)); s->heads = (i32*)allocate(count * sizeof(i32));
  return (u32)s;
}
void solve(u32 ptr, u32 start_node, double start_minutes) {
  Solver *s = (Solver*)ptr; s->heap_size = 0; s->events = 0;
  for (u32 i = 0; i < s->count; i++) { s->walking[i] = __builtin_inf(); s->arrivals[i] = __builtin_inf(); s->heads[i] = -1; }
  s->walking[start_node] = start_minutes; push(s, start_node, start_minutes);
  while (s->heap_size) {
    double time; u32 node = pop(s, &time); if (time != s->walking[node]) continue;
    for (u32 at = s->walk_offsets[node]; at < s->walk_offsets[node + 1]; at++) {
      u32 to = s->walk_to[at]; double arrival = time + s->walk_cost[at];
      if (arrival < s->walking[to] - 1e-9) { s->walking[to] = arrival; push(s, to, arrival); }
    }
  }
  u32 boardable = 0;
  for (u32 i = 0; i < s->boarding_count; i++) if (__builtin_isfinite(s->walking[s->board_from[i]])) { boardable = 1; break; }
  if (boardable) for (i32 sample = 119; sample >= 0; sample--) {
    double start = (sample + 0.5) * 0.5;
    for (u32 i = 0; i < s->boarding_count; i++) {
      double walk = s->walking[s->board_from[i]]; if (!__builtin_isfinite(walk)) continue;
      double time = departure(start + walk, s->board_phase[i], s->board_headway[i]); u32 to = s->board_to[i];
      if (time < s->arrivals[to] - 1e-9) { s->arrivals[to] = time; push(s, to, time); record(s, to, sample, time); }
    }
    while (s->heap_size) {
      double time; u32 node = pop(s, &time); if (time != s->arrivals[node]) continue;
      for (u32 at = s->walk_offsets[node]; at < s->walk_offsets[node + 1]; at++) relax(s, s->walk_to[at], time + s->walk_cost[at], start, sample);
      for (u32 at = s->transit_offsets[node]; at < s->transit_offsets[node + 1]; at++) {
        double arrival = s->headway[at] ? departure(time, s->phase[at], s->headway[at]) : time + s->transit_cost[at];
        relax(s, s->transit_to[at], arrival, start, sample);
      }
    }
  }
  for (u32 node = 0; node < s->count; node++) {
    if (s->heads[node] < 0) { s->means[node] = s->walking[node]; continue; }
    u32 lo = 0; double sum = 0;
    for (i32 at = s->heads[node]; at >= 0; at = s->previous[at]) {
      u32 hi = s->samples[at]; sum += sum_durations(s->walking[node], s->values[at], lo, hi); lo = hi + 1;
    }
    if (lo < 120) sum += (120 - lo) * s->walking[node];
    s->means[node] = sum / 120;
  }
}
u32 walking_pointer(u32 ptr) { return (u32)((Solver*)ptr)->walking; }
u32 means_pointer(u32 ptr) { return (u32)((Solver*)ptr)->means; }
u32 heads_pointer(u32 ptr) { return (u32)((Solver*)ptr)->heads; }
u32 previous_pointer(u32 ptr) { return (u32)((Solver*)ptr)->previous; }
u32 samples_pointer(u32 ptr) { return (u32)((Solver*)ptr)->samples; }
u32 values_pointer(u32 ptr) { return (u32)((Solver*)ptr)->values; }
u32 event_count(u32 ptr) { return ((Solver*)ptr)->events; }

void configure_geometry(u32 ptr, u32 original_count, u32 originals, u32 chains, u32 ca, u32 cb, u32 cl, u32 cf,
  u32 co, u32 cn, u32 cd, u32 trees, u32 tn, u32 tp, u32 tm) {
  Solver *s = (Solver*)ptr;
  s->original_count = original_count; s->originals = (u32*)originals; s->chain_count = chains;
  s->chain_a = (u32*)ca; s->chain_b = (u32*)cb; s->chain_length = (double*)cl; s->chain_flags = (u8*)cf;
  s->chain_offsets = (u32*)co; s->chain_nodes = (u32*)cn; s->chain_distances = (double*)cd;
  s->tree_count = trees; s->tree_nodes = (u32*)tn; s->tree_parents = (u32*)tp; s->tree_minutes = (double*)tm;
  s->full_times = (double*)allocate(original_count * sizeof(double));
  u32 longest = 1;
  for (u32 c = 0; c < chains; c++) { u32 k = s->chain_offsets[c + 1] - s->chain_offsets[c]; if (k > longest) longest = k; }
  s->bucket_sum = (double*)allocate(longest * sizeof(double)); s->bucket_count = (double*)allocate(longest * sizeof(double));
}
static void expand_profile(Solver *s, u32 node, double *out) {
  double walking = s->walking[node]; for (u32 i = 0; i < 120; i++) out[i] = walking;
  u32 lo = 0;
  for (i32 at = s->heads[node]; at >= 0; at = s->previous[at]) {
    u32 hi = s->samples[at]; double arrival = s->values[at];
    for (u32 i = lo; i <= hi; i++) { double value = arrival - (i + 0.5) * 0.5; out[i] = value < walking ? value : walking; }
    lo = hi + 1;
  }
}
u32 restore_geometry(u32 ptr) {
  Solver *s = (Solver*)ptr; double *times = s->full_times;
  for (u32 i = 0; i < s->original_count; i++) times[i] = __builtin_inf();
  for (u32 i = 0; i < s->count; i++) times[s->originals[i]] = s->means[i];
  double pa[120], pb[120];
  for (u32 chain = 0; chain < s->chain_count; chain++) {
    u32 a = s->chain_a[chain], b = s->chain_b[chain], flags = s->chain_flags[chain];
    u32 lo = s->chain_offsets[chain], hi = s->chain_offsets[chain + 1];
    double length = s->chain_length[chain], ma = s->means[a], mb = s->means[b];
    if (flags == 1 || (flags == 3 && __builtin_fabs(ma + length - mb) < 1e-9)) {
      for (u32 i = lo; i < hi; i++) times[s->chain_nodes[i]] = ma + s->chain_distances[i];
    } else if (flags == 2 || (flags == 3 && __builtin_fabs(mb + length - ma) < 1e-9)) {
      for (u32 i = lo; i < hi; i++) times[s->chain_nodes[i]] = mb + length - s->chain_distances[i];
    } else if (flags == 3 && __builtin_isfinite(ma) && __builtin_isfinite(mb)) {
      expand_profile(s, a, pa); expand_profile(s, b, pb);
      // For each sample f(x)=min(Ta+x,Tb+L-x): slope +1 until its crossing,
      // then -1. Bucket each crossing at the first interior vertex beyond it;
      // a prefix sweep then gives the exact average on every removed vertex.
      const double *distances = s->chain_distances + lo; u32 interior = hi - lo;
      double *bucket_sum = s->bucket_sum, *bucket_count = s->bucket_count;
      for (u32 i = 0; i < interior; i++) { bucket_sum[i] = 0; bucket_count[i] = 0; }
      double base = 0, slope = 0;
      for (u32 sample = 0; sample < 120; sample++) {
        double crossing = (pb[sample] + length - pa[sample]) / 2;
        if (crossing <= 0) { base += pb[sample] + length; slope--; }
        else {
          base += pa[sample]; slope++;
          if (crossing < length) {
            u32 left = 0, right = interior; // first distance strictly above crossing
            while (left < right) { u32 mid = (left + right) >> 1; if (distances[mid] > crossing) right = mid; else left = mid + 1; }
            if (left < interior) { bucket_sum[left] += 2 * crossing; bucket_count[left] += 2; }
          }
        }
      }
      for (u32 i = 0; i < interior; i++) {
        base += bucket_sum[i]; slope -= bucket_count[i];
        times[s->chain_nodes[lo + i]] = (base + slope * distances[i]) / 120;
      }
    }
  }
  for (u32 i = s->tree_count; i > 0; i--) { u32 at = i - 1; times[s->tree_nodes[at]] = times[s->tree_parents[at]] + s->tree_minutes[at]; }
  return (u32)times;
}
