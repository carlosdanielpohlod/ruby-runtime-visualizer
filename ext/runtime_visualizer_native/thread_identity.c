#include "thread_identity.h"
#include "extconf.h"

#include <stdatomic.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>

static _Atomic uint32_t next_serial = 1;

static uint32_t assign_serial(void)
{
    return atomic_fetch_add_explicit(&next_serial, 1, memory_order_relaxed);
}

uint32_t rv_thread_serials_assigned(void)
{
    return atomic_load_explicit(&next_serial, memory_order_relaxed) - 1;
}

#ifdef HAVE_RB_INTERNAL_THREAD_SPECIFIC_GET

/* ------------------------------------------------------------------------ */
/* Ruby 3.3+: the serial lives in a per-thread slot owned by CRuby.          */
/* ------------------------------------------------------------------------ */

static rb_internal_thread_specific_key_t serial_key;

void rv_thread_identity_init(void)
{
    /*
     * CRuby raises if the first key in the process is created while more
     * than one ractor exists, because it has to allocate the storage on
     * every existing thread. Extension load time is the safest moment.
     */
    serial_key = rb_internal_thread_specific_key_create();
}

static uint32_t serial_of(VALUE thread)
{
    uintptr_t stored = (uintptr_t)rb_internal_thread_specific_get(thread, serial_key);
    if (stored != 0) return (uint32_t)stored;

    /*
     * First sighting. Two hooks for the same thread could race here (for
     * example READY fired by a waker while the thread itself fires
     * SUSPENDED); the loser would overwrite the winner's serial and the
     * thread would appear under two ids. In practice STARTED always comes
     * first and is single-caller, and pre-existing threads are registered
     * from Ruby before the hook is installed. The consequence of the race
     * is cosmetic, never a crash, so no lock is taken here.
     */
    uint32_t serial = assign_serial();
    rb_internal_thread_specific_set(thread, serial_key, (void *)(uintptr_t)serial);
    return serial;
}

uint32_t rv_thread_serial_for_event(rb_event_flag_t event, const rb_internal_thread_event_data_t *event_data)
{
    (void)event;
    if (!event_data) return 0;
    return serial_of(event_data->thread);
}

uint32_t rv_thread_serial_current(void)
{
    return serial_of(rb_thread_current());
}

uint32_t rv_thread_serial_of(VALUE thread)
{
    return serial_of(thread);
}

bool rv_thread_identity_attached_to_thread_p(void)
{
    return true;
}

#else

/* ------------------------------------------------------------------------ */
/* Ruby 3.2: the serial lives in the native thread's TLS.                    */
/* ------------------------------------------------------------------------ */

static _Thread_local uint32_t tls_serial = 0;

void rv_thread_identity_init(void)
{
    /* nothing to prepare; TLS is zero-initialised */
}

uint32_t rv_thread_serial_for_event(rb_event_flag_t event, const rb_internal_thread_event_data_t *event_data)
{
    (void)event_data;
    /*
     * STARTED means a Ruby thread is beginning its life on this native
     * thread. With USE_THREAD_CACHE the native thread may have belonged to a
     * previous, finished Ruby thread, so a fresh serial is required even if
     * the TLS already holds one.
     */
    if (event == RUBY_INTERNAL_THREAD_EVENT_STARTED || tls_serial == 0) {
        tls_serial = assign_serial();
    }
    return tls_serial;
}

uint32_t rv_thread_serial_current(void)
{
    if (tls_serial == 0) tls_serial = assign_serial();
    return tls_serial;
}

uint32_t rv_thread_serial_of(VALUE thread)
{
    if (thread == rb_thread_current()) return rv_thread_serial_current();
    return 0;
}

bool rv_thread_identity_attached_to_thread_p(void)
{
    return false;
}

#endif

/* ------------------------------------------------------------------------ */
/* Native thread id and clock, shared by both variants.                      */
/* ------------------------------------------------------------------------ */

static _Thread_local uint32_t tls_native_thread_id = 0;

uint32_t rv_native_thread_id(void)
{
    if (tls_native_thread_id == 0) {
#ifdef HAVE_GETTID
        tls_native_thread_id = (uint32_t)gettid();
#else
        tls_native_thread_id = (uint32_t)syscall(SYS_gettid);
#endif
    }
    return tls_native_thread_id;
}

uint64_t rv_monotonic_now_ns(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
}
