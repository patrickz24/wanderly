import type { AgentResponse, Itinerary, TripBrief } from '@wanderly/contracts';
import type { DestinationCatalog } from '../agent/catalog.js';

/**
 * Business rules a schema cannot express: the itinerary has the requested number of days, in
 * order, for a destination we cover, and the brief agrees with it. Issues are phrased for the
 * model (they are sent back in the repair message).
 */
export function checkConsistency(response: AgentResponse, catalog: DestinationCatalog): string[] {
  const issues = checkBrief(response.brief, catalog);
  if (response.type === 'itinerary') {
    issues.push(...checkItinerary(response.itinerary, response.brief, catalog));
  }
  return issues;
}

function checkBrief(brief: TripBrief, catalog: DestinationCatalog): string[] {
  if (brief.destinationId === null || catalog.has(brief.destinationId)) return [];
  return [
    `brief.destinationId: "${brief.destinationId}" is not in the destination catalog. Use a catalog id or null (decline with unknown_destination for places outside the catalog).`,
  ];
}

function checkItinerary(
  itinerary: Itinerary,
  brief: TripBrief,
  catalog: DestinationCatalog,
): string[] {
  const issues: string[] = [];
  if (!catalog.has(itinerary.destinationId)) {
    issues.push(
      `itinerary.destinationId: "${itinerary.destinationId}" is not in the destination catalog.`,
    );
  }
  if (itinerary.days.length !== itinerary.durationDays) {
    issues.push(
      `itinerary.days: has ${itinerary.days.length} day(s) but durationDays is ${itinerary.durationDays}; provide exactly one entry per day.`,
    );
  }
  const outOfOrder = itinerary.days.findIndex((day, index) => day.day !== index + 1);
  if (outOfOrder !== -1) {
    issues.push(
      `itinerary.days[${outOfOrder}].day: is ${itinerary.days[outOfOrder]?.day}, expected ${outOfOrder + 1} (days are numbered 1, 2, 3… in order).`,
    );
  }
  issues.push(...briefAgreement(itinerary, brief));
  return issues;
}

function briefAgreement(itinerary: Itinerary, brief: TripBrief): string[] {
  const issues: string[] = [];
  if (brief.destinationId !== itinerary.destinationId) {
    issues.push(
      `brief.destinationId: must be "${itinerary.destinationId}", the destination of the itinerary.`,
    );
  }
  if (brief.durationDays !== itinerary.durationDays) {
    issues.push(`brief.durationDays: must be ${itinerary.durationDays}, as in the itinerary.`);
  }
  if (itinerary.month !== null && brief.month !== null && brief.month !== itinerary.month) {
    issues.push(`brief.month: ${brief.month} differs from the itinerary month ${itinerary.month}.`);
  }
  if (
    itinerary.travelers !== null &&
    brief.travelers !== null &&
    brief.travelers !== itinerary.travelers
  ) {
    issues.push(
      `brief.travelers: ${brief.travelers} differs from the itinerary travelers ${itinerary.travelers}.`,
    );
  }
  return issues;
}
