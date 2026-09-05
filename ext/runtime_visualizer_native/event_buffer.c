#include "event_buffer.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define RV_CACHE_LINE 64

/*
 * Each slot owns a cache line. Two producers writing neighbouring slots at
 * the same time would otherwise bounce the line between cores, which is
 * exactly the kind of cross-thread interference a scheduler tracer should
 * avoid adding. The cost is 2x memory versus packed slots; the default
 * capacity of 262,144 slots is 16 MiB.
 */
typedef struct {
    _Atomic uint64_t sequence;
    rv_event event;
    char padding[RV_CACHE_LINE - sizeof(_Atomic uint64_t) - sizeof(rv_event)];
} rv_slot;

struct rv_event_buffer {
    rv_slot *slots;
    size_t mask;
    size_t capacity;

    /* hot producer word, on its own line */
    _Alignas(RV_CACHE_LINE) _Atomic uint64_t enqueue_pos;
    /* hot consumer word, on its own line */
    _Alignas(RV_CACHE_LINE) _Atomic uint64_t dequeue_pos;
    /* rarely written statistics */
    _Alignas(RV_CACHE_LINE) _Atomic uint64_t dropped;
    _Atomic uint64_t high_water_mark;
};

static size_t round_up_pow2(size_t n)
{
    size_t p = 1;
    while (p < n) p <<= 1;
    return p;
}

rv_event_buffer *rv_event_buffer_new(size_t capacity)
{
    if (capacity < 2) capacity = 2;
    capacity = round_up_pow2(capacity);

    rv_event_buffer *buffer = aligned_alloc(RV_CACHE_LINE, sizeof(*buffer));
    if (!buffer) return NULL;
    memset(buffer, 0, sizeof(*buffer));

    buffer->slots = aligned_alloc(RV_CACHE_LINE, capacity * sizeof(rv_slot));
    if (!buffer->slots) {
        free(buffer);
        return NULL;
    }

    buffer->capacity = capacity;
    buffer->mask = capacity - 1;
    for (size_t i = 0; i < capacity; i++) {
        atomic_init(&buffer->slots[i].sequence, i);
    }
    atomic_init(&buffer->enqueue_pos, 0);
    atomic_init(&buffer->dequeue_pos, 0);
    atomic_init(&buffer->dropped, 0);
    atomic_init(&buffer->high_water_mark, 0);
    return buffer;
}

void rv_event_buffer_free(rv_event_buffer *buffer)
{
    if (!buffer) return;
    free(buffer->slots);
    free(buffer);
}

static void note_occupancy(rv_event_buffer *buffer, uint64_t enqueue_pos)
{
    /*
     * Approximate on purpose: dequeue_pos may move while we compute this.
     * The mark is a diagnostic ("how close did we get to dropping"), not
     * something correctness depends on.
     */
    uint64_t occupancy = enqueue_pos + 1 - atomic_load_explicit(&buffer->dequeue_pos, memory_order_relaxed);
    uint64_t seen = atomic_load_explicit(&buffer->high_water_mark, memory_order_relaxed);
    while (occupancy > seen) {
        if (atomic_compare_exchange_weak_explicit(&buffer->high_water_mark, &seen, occupancy,
                                                  memory_order_relaxed, memory_order_relaxed)) {
            break;
        }
    }
}

bool rv_event_buffer_push(rv_event_buffer *buffer, const rv_event *event, uint64_t *sequence_out)
{
    uint64_t pos = atomic_load_explicit(&buffer->enqueue_pos, memory_order_relaxed);
    rv_slot *slot;

    for (;;) {
        slot = &buffer->slots[pos & buffer->mask];
        uint64_t seq = atomic_load_explicit(&slot->sequence, memory_order_acquire);
        int64_t diff = (int64_t)seq - (int64_t)pos;

        if (diff == 0) {
            /* slot is free for this position; try to claim it */
            if (atomic_compare_exchange_weak_explicit(&buffer->enqueue_pos, &pos, pos + 1,
                                                      memory_order_relaxed, memory_order_relaxed)) {
                break;
            }
            /* lost the race; pos was reloaded by the CAS, loop */
        }
        else if (diff < 0) {
            /* the consumer has not freed this slot yet: the ring is full */
            atomic_fetch_add_explicit(&buffer->dropped, 1, memory_order_relaxed);
            return false;
        }
        else {
            /* another producer claimed this position between our load and CAS */
            pos = atomic_load_explicit(&buffer->enqueue_pos, memory_order_relaxed);
        }
    }

    slot->event = *event;
    /* publishing: the consumer's acquire load of sequence sees the event */
    atomic_store_explicit(&slot->sequence, pos + 1, memory_order_release);

    note_occupancy(buffer, pos);
    if (sequence_out) *sequence_out = pos + 1;
    return true;
}

bool rv_event_buffer_pop(rv_event_buffer *buffer, rv_event *event_out, uint64_t *sequence_out)
{
    uint64_t pos = atomic_load_explicit(&buffer->dequeue_pos, memory_order_relaxed);
    rv_slot *slot = &buffer->slots[pos & buffer->mask];
    uint64_t seq = atomic_load_explicit(&slot->sequence, memory_order_acquire);

    if ((int64_t)seq - (int64_t)(pos + 1) != 0) {
        /* either empty, or a producer claimed the slot but has not published yet */
        return false;
    }

    atomic_store_explicit(&buffer->dequeue_pos, pos + 1, memory_order_relaxed);
    *event_out = slot->event;
    if (sequence_out) *sequence_out = pos + 1;
    /* hand the slot back to producers, one lap ahead */
    atomic_store_explicit(&slot->sequence, pos + buffer->mask + 1, memory_order_release);
    return true;
}

void rv_event_buffer_reset(rv_event_buffer *buffer)
{
    for (size_t i = 0; i < buffer->capacity; i++) {
        atomic_store_explicit(&buffer->slots[i].sequence, i, memory_order_relaxed);
    }
    atomic_store_explicit(&buffer->enqueue_pos, 0, memory_order_relaxed);
    atomic_store_explicit(&buffer->dequeue_pos, 0, memory_order_relaxed);
    atomic_store_explicit(&buffer->dropped, 0, memory_order_relaxed);
    atomic_store_explicit(&buffer->high_water_mark, 0, memory_order_relaxed);
    atomic_thread_fence(memory_order_seq_cst);
}

size_t rv_event_buffer_capacity(const rv_event_buffer *buffer)
{
    return buffer->capacity;
}

uint64_t rv_event_buffer_dropped(const rv_event_buffer *buffer)
{
    return atomic_load_explicit(&buffer->dropped, memory_order_relaxed);
}

size_t rv_event_buffer_high_water_mark(const rv_event_buffer *buffer)
{
    return (size_t)atomic_load_explicit(&buffer->high_water_mark, memory_order_relaxed);
}
