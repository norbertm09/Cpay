// Résumé de caisse (GET /merchant/cash/summary), partagé par les écrans.
import { cashApi } from '../services/api';
import { useAsync } from './useAsync';

export const useCashSummary = () => {
  const { data, state, reload } = useAsync(() => cashApi.summary(), []);
  return { summary: data, state, reload };
};
