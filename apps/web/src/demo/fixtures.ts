import type {
  ConversationSummary,
  GetConversationResponse,
  SourceRef,
  SourceSummary,
  ToolCallSummary,
  TripBrief,
} from '@wanderly/contracts';
import type { AssistantMessage, RunStats } from '../lib/types';

/**
 * SAMPLE DATA for demo mode (`?demo=1`): screenshots and a server-free tour of the UI.
 *
 * Everything cited comes from the real corpus: place names, descriptions and excerpts from
 * `data/corpus/sicily/guide.md` (Wikivoyage revision 5320270, CC BY-SA 4.0) and the May
 * climate normals of `data/corpus/sicily/facts.yaml` (Open-Meteo, CC BY 4.0). No price is
 * invented: the corpus has no meal prices for Sicily, so the sample budget has no total. Tool
 * timings, token counts and costs are ILLUSTRATIVE, not measurements, and the UI labels them so.
 */

const REVISION_URL = 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=5320270';
const T0 = '2026-10-09T18:';

export const DEMO_IDS = {
  hikingTrip: '7d2a4c1e-9b3f-4e8a-a1c2-3d4e5f6a7b80',
  coastTrip: '8e3b5d2f-ac4a-4f9b-b2d3-4e5f6a7b8c91',
  runClarify: '91c6e3a0-bd5b-4a0c-83e4-5f6a7b8c9da2',
  runItinerary: 'a2d7f4b1-ce6c-4b1d-94f5-6a7b8c9daeb3',
  runDecline: 'b3e8a5c2-df7d-4c2e-a5a6-7b8c9daebfc4',
  runAnswer: 'c4f9b6d3-e08e-4d3f-b6b7-8c9daebfc0d5',
  runCoastClarify: 'd5a0c7e4-f19f-4e4a-87c8-9daebfc0d1e6',
} as const;

const chunkIds = {
  hiking: 'e6b1d8f5-a2a0-4f5b-98d9-aebfc0d1e2f7',
  borghi: 'f7c2e9a6-b3b1-4a6c-a9ea-bfc0d1e2f3a8',
  greenspaces: '08d3fab7-c4c2-4b7d-8afb-c0d1e2f3a4b9',
  performance: '19e4abc8-d5d3-4c8e-9b0c-d1e2f3a4b5ca',
  staySafe: '2af5bcd9-e6e4-4d9f-ac1d-e2f3a4b5c6db',
} as const;

const SICILY_BRIEF: TripBrief = {
  destinationId: 'sicily',
  month: 5,
  startDate: null,
  durationDays: null,
  travelers: null,
  budgetLevel: null,
  interests: ['hiking'],
  constraints: ['avoid tourist traps'],
};

// --- Sources (excerpts from the Sicily guide) -------------------------------------------------

const hikingChunk: SourceSummary = {
  kind: 'chunk',
  id: chunkIds.hiking,
  title: 'Sicily › Do › Hiking',
  destinationId: 'sicily',
  snippet:
    'Inland, the Madonie and Nebrodi mountain parks (Palermo, Messina, Enna) offer forested ridges, wildlife, and village-to-village hikes… head to the dramatic sea cliffs and coves of the Zingaro and Monte Cofano reserves (Trapani), or stroll through the quiet lagoons and dunes of Vendicari (Syracuse).',
  url: REVISION_URL,
};

const borghiChunk: SourceSummary = {
  kind: 'chunk',
  id: chunkIds.borghi,
  title: 'Sicily › See › Borghi',
  destinationId: 'sicily',
  snippet:
    'Further enriching the island’s borgo tapestry are… Geraci Siculo and Gangi in the Madonie range, offering rugged charm.',
  url: REVISION_URL,
};

const greenspacesChunk: SourceSummary = {
  kind: 'chunk',
  id: chunkIds.greenspaces,
  title: 'Sicily › See › Greenspaces',
  destinationId: 'sicily',
  snippet:
    'In Palermo, the grand 18th-century Orto Botanico and nearby Villa Giulia form one of Europe’s most important historic garden complexes.',
  url: REVISION_URL,
};

const performanceChunk: SourceSummary = {
  kind: 'chunk',
  id: chunkIds.performance,
  title: 'Sicily › See › Performance',
  destinationId: 'sicily',
  snippet:
    'Look for a show of the Opera dei Pupi, a form of puppet theatre featuring tales of knights, battles, and medieval chivalry.',
  url: REVISION_URL,
};

const staySafeChunk: SourceSummary = {
  kind: 'chunk',
  id: chunkIds.staySafe,
  title: 'Sicily › Stay safe',
  destinationId: 'sicily',
  snippet: 'Provincial roads in the interior of the island can be in bad condition.',
  url: REVISION_URL,
};

function poi(id: string, title: string, snippet: string): SourceSummary {
  return { kind: 'poi', id, title, destinationId: 'sicily', snippet, url: REVISION_URL };
}

const madonie = poi(
  'sicily-madonie-regional-natural-park',
  'Madonie Regional Natural Park',
  'Mountainous reserve east of Palermo with charming villages, hiking trails, and biodiversity.',
);
const segesta = poi(
  'sicily-segesta',
  'Segesta',
  'Well-preserved Doric temple and theatre in a bucolic setting.',
);
const valleyOfTheTemples = poi(
  'sicily-valley-of-the-temples',
  'Valley of the Temples',
  'Iconic archaeological park of ancient Akragas, featuring remarkably preserved Greek temples; a UNESCO World Heritage Site.',
);
const pantalica = poi(
  'sicily-pantalica',
  'Pantalica',
  'Vast necropolis with thousands of rock-cut tombs, set in a scenic gorge near Syracuse.',
);

const weatherSource: SourceSummary = {
  kind: 'weather',
  id: 'toolu_demo_weather',
  title: 'Sicily climate in May (Palermo, 2015–2024 normals)',
  destinationId: 'sicily',
  snippet: 'May: 23 °C / 16.1 °C, 8 rain days, 67.4 mm of precipitation',
  url: null,
};

const budgetSource: SourceSummary = {
  kind: 'budget',
  id: 'toolu_demo_budget',
  title: 'Budget estimate: mid-range, 5 days, 2 travellers',
  destinationId: 'sicily',
  snippet: 'Meal prices unknown in the Sicily guide: total and per-person cost unknown',
  url: null,
};

// --- Tool calls ---------------------------------------------------------------------------------

const itineraryToolCalls: ToolCallSummary[] = [
  {
    callId: 'toolu_demo_search_1',
    name: 'search_knowledge',
    input: { query: 'quiet hiking trails and villages', destinationId: 'sicily', k: 6 },
    ok: true,
    durationMs: 0,
    summary: '6 excerpts, from Do › Hiking, See › Borghi and Stay safe',
  },
  {
    callId: 'toolu_demo_pois_1',
    name: 'search_pois',
    input: { destinationId: 'sicily', kinds: ['hiking', 'nature'], maxCrowd: 2, month: 5 },
    ok: true,
    durationMs: 0,
    summary: '6 places; none has a crowd level in the guide',
  },
  {
    callId: 'toolu_demo_pois_2',
    name: 'search_pois',
    input: { destinationId: 'sicily', kinds: ['historic_site'] },
    ok: true,
    durationMs: 0,
    summary: '4 places: Mozia, Pantalica, Segesta, Valley of the Temples',
  },
  {
    callId: 'toolu_demo_search_2',
    name: 'search_knowledge',
    input: {
      query: 'calm first day in Palermo: gardens and evening culture',
      destinationId: 'sicily',
    },
    ok: false,
    durationMs: 0,
    summary: 'Timed out: the tool time limit was reached',
  },
  {
    callId: 'toolu_demo_search_3',
    name: 'search_knowledge',
    input: { query: 'Palermo gardens and puppet theatre', destinationId: 'sicily', k: 4 },
    ok: true,
    durationMs: 0,
    summary: '4 excerpts, from See › Greenspaces and See › Performance',
  },
  {
    callId: 'toolu_demo_weather',
    name: 'get_seasonal_weather',
    input: { destinationId: 'sicily', month: 5 },
    ok: true,
    durationMs: 0,
    summary: 'May in Sicily: 23 °C / 16.1 °C, 8 rain days',
  },
  {
    callId: 'toolu_demo_budget',
    name: 'estimate_budget',
    input: { destinationId: 'sicily', days: 5, travelers: 2, level: 'mid' },
    ok: true,
    durationMs: 0,
    summary: 'Meal prices unknown for Sicily: no total',
  },
];

// --- Trip 1: clarification → itinerary → decline ------------------------------------------------

const clarifyMessage: AssistantMessage = {
  id: '3a06cdea-f7f5-4eaa-bd2e-f3a4b5c6d7ec',
  role: 'assistant',
  runId: DEMO_IDS.runClarify,
  response: {
    type: 'clarification',
    message: 'Sicily in May is a good fit for hiking. Two details will shape the plan:',
    questions: [
      'How many days will you spend in Sicily, and how many of you are travelling?',
      'What budget level do you have in mind (budget, mid or comfort)?',
    ],
    brief: SICILY_BRIEF,
  },
  sources: [],
  toolCalls: [],
  createdAt: `${T0}02:04.000Z`,
};

const itineraryMessage: AssistantMessage = {
  id: '4b17defb-a8a6-4fbb-8e3f-a4b5c6d7e8fd',
  role: 'assistant',
  runId: DEMO_IDS.runItinerary,
  response: {
    type: 'itinerary',
    message:
      'Here is a five-day plan that mixes mountain and coastal walks with a few major ancient sites, favouring small villages where the guide allows.',
    brief: { ...SICILY_BRIEF, durationDays: 5, travelers: 2, budgetLevel: 'mid' },
    itinerary: {
      destinationId: 'sicily',
      title: 'Five quiet hiking days in Sicily',
      summary:
        'From the gardens of Palermo to the Madonie mountains, the Zingaro coast, Agrigento and the Pantalica gorge, with time for small hill villages.',
      month: 5,
      durationDays: 5,
      travelers: 2,
      days: [
        {
          day: 1,
          theme: 'A gentle start in Palermo',
          items: [
            {
              slot: 'afternoon',
              title: 'Orto Botanico and Villa Giulia',
              poiId: null,
              description:
                'Stroll through Palermo’s 18th-century botanical garden and the neighbouring Villa Giulia.',
              justification:
                'A shaded, low-key first afternoon after travelling; the guide ranks the pair among Europe’s most important historic gardens.',
              sourceRefs: [{ kind: 'chunk', id: chunkIds.greenspaces }],
            },
            {
              slot: 'evening',
              title: 'Opera dei Pupi puppet show',
              poiId: null,
              description:
                'Sicily’s traditional puppet theatre, with tales of knights and medieval chivalry, still performed in Palermo.',
              justification:
                'A local tradition rather than a tourist set piece, and an easy evening before the hiking days.',
              sourceRefs: [{ kind: 'chunk', id: chunkIds.performance }],
            },
          ],
        },
        {
          day: 2,
          theme: 'Madonie mountains and hill villages',
          items: [
            {
              slot: 'morning',
              title: 'Hike in the Madonie Regional Natural Park',
              poiId: madonie.id,
              description:
                'Forested ridges and village-to-village trails in the mountain park east of Palermo.',
              justification:
                'Hiking is your main interest, and the guide names the Madonie among the island’s inland hiking parks.',
              sourceRefs: [
                { kind: 'poi', id: madonie.id },
                { kind: 'chunk', id: chunkIds.hiking },
              ],
            },
            {
              slot: 'afternoon',
              title: 'Geraci Siculo and Gangi',
              poiId: null,
              description: 'Two hill villages of the Madonie range, listed among Sicily’s borghi.',
              justification:
                'Small villages instead of headline sights, in line with avoiding tourist traps.',
              sourceRefs: [{ kind: 'chunk', id: chunkIds.borghi }],
            },
          ],
        },
        {
          day: 3,
          theme: 'The west: Zingaro coast and Segesta',
          items: [
            {
              slot: 'morning',
              title: 'Coastal walk in the Zingaro reserve',
              poiId: null,
              description: 'Sea cliffs and coves on the coast of the Trapani province.',
              justification:
                'A walking day by the sea: the guide recommends the Zingaro and Monte Cofano reserves for coastal walking.',
              sourceRefs: [{ kind: 'chunk', id: chunkIds.hiking }],
            },
            {
              slot: 'afternoon',
              title: 'Segesta',
              poiId: segesta.id,
              description: 'A well-preserved Doric temple and theatre in a bucolic setting.',
              justification: 'An ancient site in open countryside, after a morning outdoors.',
              sourceRefs: [{ kind: 'poi', id: segesta.id }],
            },
          ],
        },
        {
          day: 4,
          theme: 'Agrigento',
          items: [
            {
              slot: 'morning',
              title: 'Valley of the Temples',
              poiId: valleyOfTheTemples.id,
              description:
                'The archaeological park of ancient Akragas, with remarkably preserved Greek temples (UNESCO).',
              justification:
                'The one famous site of the trip, kept for a morning visit: the guide has no crowd figures for it.',
              sourceRefs: [{ kind: 'poi', id: valleyOfTheTemples.id }],
            },
          ],
        },
        {
          day: 5,
          theme: 'Gorges and lagoons near Syracuse',
          items: [
            {
              slot: 'morning',
              title: 'Pantalica gorge and necropolis',
              poiId: pantalica.id,
              description: 'Thousands of rock-cut tombs in a scenic limestone gorge near Syracuse.',
              justification:
                'Combines a gorge hike with archaeology; the guide lists Pantalica among its canyon walks.',
              sourceRefs: [
                { kind: 'poi', id: pantalica.id },
                { kind: 'chunk', id: chunkIds.hiking },
              ],
            },
            {
              slot: 'afternoon',
              title: 'Vendicari lagoons',
              poiId: null,
              description: 'An easy walk through lagoons and dunes in the Syracuse area.',
              justification: 'A gentle last walk; the guide describes these lagoons as quiet.',
              sourceRefs: [{ kind: 'chunk', id: chunkIds.hiking }],
            },
          ],
        },
      ],
      budget: {
        level: 'mid',
        currency: 'unknown',
        total: null,
        perPerson: null,
        fromToolCallId: 'toolu_demo_budget',
        notes: [
          'Meal prices are unknown: no Eat listing in the guide has a parseable price.',
          'Without meal prices, no total is given rather than a partial guess.',
        ],
      },
      weather: {
        month: 5,
        summary:
          'Good walking weather: average highs around 23 °C and lows around 16 °C, with about 8 rainy days in the month.',
        fromToolCallId: 'toolu_demo_weather',
      },
      assumptions: [
        'A rental car is assumed: the days span the Palermo, Trapani, Agrigento and Syracuse areas.',
        'No trail lengths or durations are given, because the guide has none.',
      ],
      warnings: [
        'Trail signage varies: carry a GPS map and avoid hiking in the midday heat.',
        'Provincial roads in the interior can be in bad condition: allow extra driving time.',
        'The guide has no crowd data for these places, so “quiet” rests on its descriptions, not on visitor numbers.',
      ],
    },
  },
  sources: [
    greenspacesChunk,
    performanceChunk,
    madonie,
    hikingChunk,
    borghiChunk,
    segesta,
    valleyOfTheTemples,
    pantalica,
    staySafeChunk,
    weatherSource,
    budgetSource,
  ],
  toolCalls: itineraryToolCalls,
  createdAt: `${T0}03:31.000Z`,
};

const declineMessage: AssistantMessage = {
  id: '5c28efac-b9b7-4acc-9f4a-b5c6d7e8f90e',
  role: 'assistant',
  runId: DEMO_IDS.runDecline,
  response: {
    type: 'decline',
    reason: 'out_of_scope',
    message:
      'I can’t book flights or cars. I can keep refining this plan, or answer questions about Sicily from the guide.',
    brief: { ...SICILY_BRIEF, durationDays: 5, travelers: 2, budgetLevel: 'mid' },
  },
  sources: [],
  toolCalls: [],
  createdAt: `${T0}05:12.000Z`,
};

// --- Trip 2: answer → clarification (quick replies) ---------------------------------------------

const coastAnswer: AssistantMessage = {
  id: '6d39fabd-cac8-4bdd-a05b-c6d7e8f90a1f',
  role: 'assistant',
  runId: DEMO_IDS.runAnswer,
  response: {
    type: 'answer',
    message:
      'For coastal walks, the guide points to the sea cliffs and coves of the Zingaro and Monte Cofano reserves near Trapani, and to the quiet lagoons and dunes of Vendicari near Syracuse. Signage varies, so carry a GPS map, and avoid the midday heat in summer.',
    sourceRefs: [{ kind: 'chunk', id: chunkIds.hiking }],
    brief: { ...SICILY_BRIEF, month: null, interests: ['coastal walks'], constraints: [] },
  },
  sources: [hikingChunk],
  toolCalls: [
    {
      callId: 'toolu_demo_coast_search',
      name: 'search_knowledge',
      input: { query: 'coastal walks', destinationId: 'sicily', k: 5 },
      ok: true,
      durationMs: 0,
      summary: '5 excerpts, from Do › Hiking and Do › Beaches',
    },
  ],
  createdAt: '2026-10-08T10:15:40.000Z',
};

const coastClarify: AssistantMessage = {
  id: '7e4a0bce-dbd9-4cee-b16c-d7e8f90a1b20',
  role: 'assistant',
  runId: DEMO_IDS.runCoastClarify,
  response: {
    type: 'clarification',
    message: 'Happy to. To build a day-by-day plan around these walks, I need two details:',
    questions: [
      'Which month are you travelling in, and for how many days?',
      'What budget level do you have in mind: budget, mid or comfort?',
    ],
    brief: { ...SICILY_BRIEF, month: null, interests: ['coastal walks'], constraints: [] },
  },
  sources: [],
  toolCalls: [],
  createdAt: '2026-10-08T10:16:22.000Z',
};

// --- Conversations -----------------------------------------------------------------------------

export const DEMO_CONVERSATIONS: readonly GetConversationResponse[] = [
  {
    id: DEMO_IDS.hikingTrip,
    title: 'Quiet hiking days in Sicily',
    createdAt: `${T0}02:00.000Z`,
    updatedAt: `${T0}05:12.000Z`,
    brief: { ...SICILY_BRIEF, durationDays: 5, travelers: 2, budgetLevel: 'mid' },
    messages: [
      {
        id: '0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b',
        role: 'user',
        text: 'We’d like a quiet hiking trip to Sicily in May, away from the tourist traps.',
        createdAt: `${T0}02:00.000Z`,
      },
      clarifyMessage,
      {
        id: '1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c',
        role: 'user',
        text: '5 days, two of us, mid budget.',
        createdAt: `${T0}03:05.000Z`,
      },
      itineraryMessage,
      {
        id: '2a3b4c5d-6e7f-4a8b-ac9d-0e1f2a3b4c5d',
        role: 'user',
        text: 'Perfect! Can you also book the flights and a rental car for us?',
        createdAt: `${T0}05:09.000Z`,
      },
      declineMessage,
    ],
  },
  {
    id: DEMO_IDS.coastTrip,
    title: 'Coastal walks in Sicily',
    createdAt: '2026-10-08T10:15:20.000Z',
    updatedAt: '2026-10-08T10:16:22.000Z',
    brief: { ...SICILY_BRIEF, month: null, interests: ['coastal walks'], constraints: [] },
    messages: [
      {
        id: '3b4c5d6e-7f8a-4b9c-bd0e-1f2a3b4c5d6e',
        role: 'user',
        text: 'Where can we walk along the coast in Sicily?',
        createdAt: '2026-10-08T10:15:20.000Z',
      },
      coastAnswer,
      {
        id: '4c5d6e7f-8a9b-4cad-8e1f-2a3b4c5d6e7f',
        role: 'user',
        text: 'Nice! Could you plan a few days around those walks?',
        createdAt: '2026-10-08T10:16:01.000Z',
      },
      coastClarify,
    ],
  },
];

export const DEMO_SUMMARIES: readonly ConversationSummary[] = DEMO_CONVERSATIONS.map(
  ({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }),
);

/** Illustrative run statistics (not measurements), shown with a "demo" label. */
export const DEMO_RUN_STATS: Readonly<Record<string, RunStats>> = {
  [DEMO_IDS.runClarify]: {
    steps: 1,
    usage: { inputTokens: 3120, outputTokens: 240, cacheReadTokens: 2048, cacheWriteTokens: 0 },
    costUsd: 0.0041,
    latencyMs: 2870,
    traceId: null,
  },
  [DEMO_IDS.runItinerary]: {
    steps: 4,
    usage: { inputTokens: 21480, outputTokens: 2960, cacheReadTokens: 12288, cacheWriteTokens: 0 },
    costUsd: 0.0368,
    latencyMs: 24310,
    traceId: null,
  },
  [DEMO_IDS.runDecline]: {
    steps: 1,
    usage: { inputTokens: 3980, outputTokens: 150, cacheReadTokens: 3072, cacheWriteTokens: 0 },
    costUsd: 0.0045,
    latencyMs: 2140,
    traceId: null,
  },
  [DEMO_IDS.runAnswer]: {
    steps: 2,
    usage: { inputTokens: 6210, outputTokens: 410, cacheReadTokens: 3072, cacheWriteTokens: 0 },
    costUsd: 0.0089,
    latencyMs: 6420,
    traceId: null,
  },
  [DEMO_IDS.runCoastClarify]: {
    steps: 1,
    usage: { inputTokens: 7020, outputTokens: 260, cacheReadTokens: 6144, cacheWriteTokens: 0 },
    costUsd: 0.0078,
    latencyMs: 3010,
    traceId: null,
  },
};

export interface DemoReplay {
  readonly toolCalls: ToolCallSummary[];
  readonly sources: SourceSummary[];
  readonly message: string;
  readonly stats: RunStats;
}

/** The recorded answer demo mode replays for any new message. */
export const DEMO_REPLAY: DemoReplay = {
  toolCalls: [
    {
      callId: 'toolu_demo_replay_search',
      name: 'search_knowledge',
      input: { query: 'hiking areas', destinationId: 'sicily', k: 4 },
      ok: true,
      durationMs: 0,
      summary: '4 excerpts, from Do › Hiking and Other destinations',
    },
    {
      callId: 'toolu_demo_replay_pois',
      name: 'search_pois',
      input: { destinationId: 'sicily', kinds: ['hiking'], maxCrowd: 2 },
      ok: true,
      durationMs: 0,
      summary: '1 place: Madonie Regional Natural Park (crowd level unknown)',
    },
    {
      callId: 'toolu_demo_replay_weather',
      name: 'get_seasonal_weather',
      input: { destinationId: 'sicily', month: 5 },
      ok: true,
      durationMs: 0,
      summary: 'May in Sicily: 23 °C / 16.1 °C, 8 rain days',
    },
  ],
  sources: [hikingChunk, madonie, pantalica],
  message:
    'Demo mode replays this recorded answer whatever you write: no AI model is called. As an example of a grounded answer, the Sicily guide suggests the Madonie and Nebrodi mountain parks for forested ridges and village-to-village hikes, and the gorge of Pantalica near Syracuse for a walk among rock-cut tombs.',
  stats: {
    steps: 2,
    usage: { inputTokens: 5480, outputTokens: 380, cacheReadTokens: 3072, cacheWriteTokens: 0 },
    costUsd: 0.0077,
    latencyMs: 5200,
    traceId: null,
  },
};

export const DEMO_REPLAY_SOURCE_REFS: readonly SourceRef[] = [
  { kind: 'chunk', id: chunkIds.hiking },
  { kind: 'poi', id: madonie.id },
  { kind: 'poi', id: pantalica.id },
];
