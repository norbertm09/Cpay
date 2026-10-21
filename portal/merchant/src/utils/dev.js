// Outils de développement : préremplissage par paramètres d'URL, actifs
// uniquement dans un build lancé avec REACT_APP_DEV_TOOLS=1 (mock API,
// captures d'écran). En production la fonction renvoie toujours null.
export const devParams = () => {
  if (import.meta.env.REACT_APP_DEV_TOOLS !== '1') return null;
  try { return new URLSearchParams(window.location.search); } catch (e) { return null; }
};
