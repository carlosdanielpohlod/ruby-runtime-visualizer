/*
 * Ruby thread identity, native thread identity, and the clock.
 *
 * A Ruby thread is identified by a serial number that this module assigns
 * the first time it sees the thread. The serial is deliberately not the
 * native thread id: on Ruby 3.3+ with M:N scheduling several Ruby threads
 * take turns on one native thread, and on 3.2 a finished thread's native
 * thread is cached and reused by the next Thread.new.
 *
 * How the serial is stored depends on the CRuby version:
 *
 *   3.3+  rb_internal_thread_specific_{get,set} give every rb_thread_t a
 *         handful of void* slots. They are documented async-signal-safe and
 *         thread-safe (they are a plain array access on the thread struct),
 *         so they can be used from a hook that runs without the GVL. The
 *         serial is stored directly in the slot, cast to a pointer, so no
 *         memory is ever allocated from a callback.
 *
 *   3.2   event_data is NULL and there is no per-thread slot. But 3.2 is a
 *         strict 1:1 scheduler and every hook runs on the Ruby thread's own
 *         native thread, so a _Thread_local variable is the identity.
 */
#ifndef RV_THREAD_IDENTITY_H
#define RV_THREAD_IDENTITY_H

#include <ruby/ruby.h>
#include <ruby/thread.h>
#include <stdbool.h>
#include <stdint.h>

/* Must be called once at extension load, with the GVL, before any other ractor exists. */
void rv_thread_identity_init(void);

/*
 * Serial for the thread an internal thread event refers to. Safe to call from
 * the hook: no GVL, no allocation, no Ruby API beyond the thread-specific
 * accessors. Returns 0 if the thread cannot be identified.
 */
uint32_t rv_thread_serial_for_event(rb_event_flag_t event, const rb_internal_thread_event_data_t *event_data);

/* Serial of the calling Ruby thread. Requires the GVL on 3.3+ (uses rb_thread_current). */
uint32_t rv_thread_serial_current(void);

/*
 * Serial of an arbitrary Thread object. Requires the GVL. On 3.2 this cannot
 * be answered (the identity lives in another native thread's TLS) and 0 is
 * returned; the Ruby side maps threads through Thread#native_thread_id there.
 */
uint32_t rv_thread_serial_of(VALUE thread);

/* How many serials have been handed out so far in this process. */
uint32_t rv_thread_serials_assigned(void);

/* true on 3.3+, where serials are attached to the Thread object itself. */
bool rv_thread_identity_attached_to_thread_p(void);

/* gettid(), cached per native thread. */
uint32_t rv_native_thread_id(void);

/* CLOCK_MONOTONIC in nanoseconds. vDSO backed on Linux, no syscall. */
uint64_t rv_monotonic_now_ns(void);

#endif
