import type { FastifyInstance } from 'fastify';
import { db } from '../supabase.js';

export async function eventsRoutes(app: FastifyInstance) {
  // GET /events - List all events
  app.get('/', async (request) => {
    const userId = request.userId;

    // Check if the user is a sitter
    const { data: profile } = await db
      .from('profiles_private')
      .select('isSitter')
      .eq('id', userId)
      .maybeSingle();

    let approvedHostIds: string[] = [];
    if (profile?.isSitter) {
      const { data: hostSitters } = await db
        .from('host_sitters')
        .select('host')
        .eq('sitter', userId)
        .eq('sitter_status', 'approved');
      approvedHostIds = (hostSitters ?? []).map((hs) => hs.host);
    }

    // Build OR filter: user's own events + unclaimed events from approved hosts
    const orParts = [`host.eq.${userId}`, `sitter.eq.${userId}`];
    if (approvedHostIds.length > 0) {
      orParts.push(
        `and(host.in.(${approvedHostIds.join(',')}),sitter.is.null)`,
      );
    }

    const { data, error } = await db
      .from('events')
      .select('*')
      .or(orParts.join(','))
      .eq('is_deleted', false)
      .gte('event_timestamp', new Date().toISOString())
      .order('event_timestamp', { ascending: true });

    if (error) throw error;
    return data || [];
  });

  // GET /events/usage - Get current month's event usage for the logged-in host
  app.get('/usage', async (request, reply) => {
    const userId = request.userId;

    // Get subscription level
    const { data: profileData, error: profileErr } = await db
      .from('profiles_private')
      .select('subscription_level_id, subscription_levels(events_per_month)')
      .eq('id', userId)
      .maybeSingle();

    if (profileErr || !profileData) {
      return reply
        .status(500)
        .send({ error: 'Failed to load subscription data' });
    }

    const eventLimit =
      (profileData.subscription_levels as any)?.events_per_month ?? 3;

    // Count events created this month
    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);
    const monthStart = currentMonth.toISOString();

    const nextMonth = new Date(currentMonth);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const monthEnd = nextMonth.toISOString();

    const { count: eventCount, error: countErr } = await db
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('host', userId)
      .gte('created_at', monthStart)
      .lt('created_at', monthEnd);

    if (countErr) {
      return reply.status(500).send({ error: 'Failed to load usage data' });
    }

    return {
      current: eventCount ?? 0,
      limit: eventLimit,
      month: monthStart.split('T')[0],
    };
  });

  // GET /events/:id - Get single event
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const eventId = parseInt(request.params.id);
    if (isNaN(eventId)) {
      return reply.status(400).send({ error: 'Invalid event ID' });
    }

    const { data, error } = await db
      .from('events')
      .select('*')
      .eq('id', eventId)
      .eq('is_deleted', false)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Event not found' });
      }
      throw error;
    }

    return data;
  });

  // PATCH /events/:id - Update event fields
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      description?: string | null;
      event_timestamp?: string;
      end_timestamp?: string | null;
      sitter?: string | null;
    };
  }>('/:id', async (request, reply) => {
    const eventId = parseInt(request.params.id);
    if (isNaN(eventId)) {
      return reply.status(400).send({ error: 'Invalid event ID' });
    }

    const userId = request.userId;
    const updates = request.body;

    // Verify the user is the host or is claiming/unclaiming as a sitter
    const { data: existingEvent } = await db
      .from('events')
      .select('host, sitter, is_deleted')
      .eq('id', eventId)
      .single();

    if (!existingEvent || existingEvent.is_deleted) {
      return reply.status(404).send({ error: 'Event not found' });
    }

    // Hosts can update anything, sitters can only claim (set sitter to themselves)
    const isHostOfEvent = existingEvent.host === userId;
    const isClaimingEvent =
      Object.keys(updates).length === 1 &&
      'sitter' in updates &&
      updates.sitter === userId;

    if (isClaimingEvent) {
      const { data: profile } = await db
        .from('profiles_private')
        .select('isHost')
        .eq('id', userId)
        .maybeSingle();

      if (profile?.isHost) {
        return reply
          .status(403)
          .send({ error: 'Hosts cannot claim events' });
      }
    }

    if (!isHostOfEvent && !isClaimingEvent) {
      return reply
        .status(403)
        .send({ error: 'Not authorized to update this event' });
    }

    const { data, error } = await db
      .from('events')
      .update(updates)
      .eq('id', eventId)
      .select()
      .single();

    if (error) throw error;
    return data;
  });

  // DELETE /events/:id - Delete event
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const eventId = parseInt(request.params.id);
    if (isNaN(eventId)) {
      return reply.status(400).send({ error: 'Invalid event ID' });
    }

    // Verify ownership
    const { data: existing } = await db
      .from('events')
      .select('host, is_deleted')
      .eq('id', eventId)
      .single();

    if (!existing || existing.is_deleted) {
      return reply.status(404).send({ error: 'Event not found' });
    }
    if (existing.host !== request.userId) {
      return reply
        .status(403)
        .send({ error: 'Not authorized to delete this event' });
    }

    const { error } = await db
      .from('events')
      .update({ is_deleted: true })
      .eq('id', eventId);
    if (error) throw error;

    return { success: true };
  });
}
