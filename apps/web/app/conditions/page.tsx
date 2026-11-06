export const metadata = { title: "Conditions de la bêta · ChessArena" };

/** Conditions de participation à la bêta (jetons sans valeur). */
export default function Conditions() {
  return (
    <main className="arena-app px-4 py-8">
      <article className="panel mx-auto flex max-w-2xl flex-col gap-4 p-6 text-sm leading-relaxed">
        <h1 className="font-display text-2xl font-bold">Conditions de la bêta</h1>
        <p className="text-muted">Version de test du site. Ces conditions pourront évoluer avant l'ouverture officielle.</p>

        <section>
          <h2 className="mb-1 font-semibold">1. Jetons sans valeur</h2>
          <p>Pendant la bêta, toutes les parties et tous les tournois se jouent en jetons PLAY. Ils n'ont aucune valeur monétaire, ne s'achètent pas, ne se vendent pas et ne s'échangent pas.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold">2. Âge</h2>
          <p>Le compte est réservé aux personnes de 18 ans ou plus.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold">3. Fair-play</h2>
          <p>Pendant une partie, aucune aide extérieure n'est permise : moteur d'analyse, base de données, autre personne. L'analyse Stockfish du site n'est disponible que sur les parties terminées. Les parties sont contrôlées automatiquement ; un compte qui triche peut être suspendu.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold">4. Ton compte</h2>
          <p>Un compte par personne. Garde ton mot de passe pour toi : il est stocké uniquement sous forme chiffrée (hachage) et personne, y compris l'équipe, ne peut le lire.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold">5. Données</h2>
          <p>Nous conservons ton pseudo, ton drapeau, ton e-mail si tu le donnes, tes parties et ton répertoire, uniquement pour faire fonctionner le site. Ils ne sont ni vendus ni partagés. Tu peux demander la suppression de ton compte à l'organisateur de la bêta.</p>
        </section>
        <a href="/" className="neon-btn self-start rounded-lg px-4 py-2 font-semibold">Retour</a>
      </article>
    </main>
  );
}
