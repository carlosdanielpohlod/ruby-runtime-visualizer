# CRuby hooks used by the recorder

Exact APIs, where they fire, and the safety rules that follow. Version
notes are from reading `thread_pthread.c`, `thread_pthread_mn.c`,
`thread.c` and `include/ruby/thread.h` at the tagged releases; see
`docs/research.md` for the line-level references and the experiments.

## `rb_internal_thread_add_event_hook` (Ruby ≥ 3.2)

```c
#include <ruby/thread.h>

rb_internal_thread_event_hook_t *
rb_internal_thread_add_event_hook(rb_internal_thread_event_callback func,
                                  rb_event_flag_t events, void *data);
bool rb_internal_thread_remove_event_hook(rb_internal_thread_event_hook_t *hook);

typedef void (*rb_internal_thread_event_callback)(rb_event_flag_t event,
        const rb_internal_thread_event_data_t *event_data, void *user_data);
```

Status: public header, but the header itself calls the events
"internal". It is a no-op on Windows and WebAssembly. Shape changed
between 3.2 and 3.3 (`event_data`). Treat as *unstable*.

| Event       | What CRuby just did or is about to do | GVL in callback | Native thread running the callback |
|-------------|----------------------------------------|-----------------|-------------------------------------|
| `STARTED`   | About to create the native thread for a Ruby thread (3.3+), or the new native thread just began (3.2) | 3.3+: creator holds it; 3.2: no | 3.3+: creator; 3.2: the new thread |
| `READY`     | Thread enqueued on the scheduler's ready queue | no (the waker may hold it) | 3.3+: whoever enqueued it; 3.2: the thread itself |
| `RESUMED`   | `sched->running == th`, about to run Ruby code | **yes** | the thread itself |
| `SUSPENDED` | Giving up the lock (blocking region, sleep, yield, wait, exit) | no | the thread itself |
| `EXITED`    | Ruby thread finished | no | the thread itself |

Rules the recorder follows in `on_thread_event`:

1. Never call `rb_internal_thread_add_event_hook` / `remove` from inside
   a callback (the header forbids it: the hook list rwlock is held).
2. Never block. On every version the caller holds, or is about to take,
   the scheduler lock. A blocked callback stops every thread switch.
3. Never allocate through Ruby, raise, or call into the VM. Only
   `rb_internal_thread_specific_get/set` (3.3+), which are plain array
   accesses on `rb_thread_t` and documented thread-safe.
4. Use `event_data->thread` (3.3+) for identity, never the native thread.
5. Read the clock before claiming a slot, so the timestamp is the moment
   the scheduler called us, not the moment the ring accepted the event.

### What the events do *not* say

- Why the thread released the lock. `SUSPENDED` covers IO, `sleep`,
  `Thread.pass`, `Mutex#lock` contention, `Queue#pop`, timeslice yield
  and thread exit.
- Which ractor the thread belongs to.
- On 3.2, which Ruby thread the event is about (identity comes from TLS).
- Whether a `READY` thread already owns the lock (it does when the queue
  was empty; `RESUMED` follows immediately).

## `rb_internal_thread_specific_*` (Ruby ≥ 3.3)

```c
rb_internal_thread_specific_key_t rb_internal_thread_specific_key_create(void);
void *rb_internal_thread_specific_get(VALUE thread, rb_internal_thread_specific_key_t key);
void  rb_internal_thread_specific_set(VALUE thread, rb_internal_thread_specific_key_t key, void *data);
```

Eight slots per process (`RB_INTERNAL_THREAD_SPECIFIC_KEY_MAX`). The
first key must be created while only one ractor exists; the recorder
creates its key at extension load. The recorder stores the thread serial
in the slot directly, cast to a pointer, so it never allocates.

## `rb_tracepoint_new` with `RUBY_INTERNAL_EVENT_GC_ENTER` / `GC_EXIT`

```c
#include <ruby/debug.h>
VALUE tp = rb_tracepoint_new(Qnil, RUBY_INTERNAL_EVENT_GC_ENTER | RUBY_INTERNAL_EVENT_GC_EXIT, callback, NULL);
rb_tracepoint_enable(tp);
```

Internal events are only available from C. The callback runs with the
GVL, on the thread that triggered the collection, *inside* the collector:
no Ruby allocation is allowed. The recorder writes one ring entry and
returns. `rb_tracearg_event_flag(rb_tracearg_from_tracepoint(tp))` tells
enter from exit.

## `TracePoint.new(:line)` (Ruby level, optional)

Public and stable API, used only for the `tracepoint:line` channel. Runs
with the GVL on the executing thread. It is the expensive channel; see
`docs/tracing-overhead.md`.

## `Process._fork` (Ruby ≥ 3.1)

Public API for libraries that need to react to fork. The child inherits
the hook registration and a copy of the ring. The recorder does not call
`rb_internal_thread_remove_event_hook` in the child, because the hook
list's rwlock state was copied from the parent and another parent thread
may have held it at fork time. Instead the inherited hook is left in place
and disarmed with an atomic flag it checks first; a new hook is registered
for the child's own session.

## `gettid(2)` and `CLOCK_MONOTONIC`

Linux only for now. `gettid()` is cached in a `_Thread_local` so it costs
one syscall per native thread. `clock_gettime(CLOCK_MONOTONIC)` is vDSO
backed and is the same clock as
`Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)`, so Ruby
code can produce timestamps comparable with the trace.

## Not used, on purpose

- `ruby_thread_has_gvl_p()`: exported everywhere but only declared in the
  public header from 4.0, and inside these callbacks its answer is not
  "does this thread own the lock" (on 3.2 it reports true for a thread
  that is merely not in a blocking region).
- `rb_frame_method_id_and_class` from `SUSPENDED` to detect `sleep`:
  inspects the execution context without the GVL. It works in practice;
  it is exactly what this project promised not to do. The sleep probe
  runs with the GVL instead.
- `Thread#native_thread_id` as identity: correct on 3.2 (1:1) and wrong
  under M:N.
