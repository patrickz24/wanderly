import type { DeclineReason } from '@wanderly/contracts';

/** Reason-specific wording for a declined request. Declining is a feature, not an error. */
export const DECLINE_EXPLANATIONS: Readonly<
  Record<DeclineReason, { readonly title: string; readonly explanation: string }>
> = {
  out_of_scope: {
    title: 'Outside what Wanderly does',
    explanation:
      'Wanderly plans trips and answers travel questions about the destinations in its guide. It cannot book, buy or handle other topics.',
  },
  unknown_destination: {
    title: 'Destination not in the guide',
    explanation:
      "This place is not in Wanderly's guide yet, and the assistant does not answer from memory. The guide covers 20 European destinations, such as Sicily, Madeira, Crete and Lofoten.",
  },
  insufficient_data: {
    title: 'Not enough information',
    explanation:
      "The guide does not have enough reliable information to answer this well, so the assistant won't make it up.",
  },
  unsafe: {
    title: "Can't help with this request",
    explanation: 'This request is outside what Wanderly can safely help with.',
  },
};
