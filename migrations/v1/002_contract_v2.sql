-- Contrat de partenariat v2.0 : texte exact affiché par l'Espace fitness (fitness.html, CONTRACT avec « la Salle »).
-- L'empreinte est calculée par Postgres sur ce texte ; la page envoie la même empreinte à la signature.
update contract_versions set is_current = false where is_current and version <> '2.0';
insert into contract_versions (version, text, sha256, is_current)
values ('2.0', $ct$1. Parties
VOLT., entreprise individuelle exploitée par M. Reda Hassini, Rue de la Baumettaz 12, 1023 Crissier, IDE [CHE-___.___.___] (« VOLT. »).
la Salle — [raison sociale, IDE, adresse] (« la Salle »).

2. Objet
Dans le cadre d'un partenariat, VOLT. met à disposition de la Salle et maintient une station de boissons VOLT. Pro (concentrés en poches de 5 L), une tablette fixée à la station qui lit le badge et autorise la distribution, un module de commande (relais, contact sec), l'accès à l'Espace fitness et la livraison des concentrés.
Les membres se servent avec leur badge habituel, à raison d'une boisson toutes les 15 minutes. L'accès VOLT. est intégré à l'abonnement de la Salle, qui en fixe librement le prix. VOLT. ne facture rien aux membres.

3. Durée
Durée ferme de 36 mois (3 ans) à compter de la signature du procès-verbal de réception, puis renouvellement tacite par périodes de 12 mois, sauf résiliation écrite moyennant un préavis de 3 mois avant l'échéance.

4. Partage des revenus
VOLT. et la Salle se partagent les revenus générés par le service VOLT. inclus dans les abonnements de la Salle. 
Les modalités financières (clé de répartition, base de calcul, périodicité des décomptes, options telles que le filtre) sont convenues directement entre VOLT. et la Salle, par écrit (email ou offre signée).
VOLT. se réserve le droit d'ajuster ces modalités ainsi que les conditions d'exploitation du service (fréquence de livraison, assortiment des saveurs, réglages de la station). Elle en informe la Salle par écrit au moins 30 jours à l'avance, avec la justification ; les nouvelles conditions s'appliquent dès la date indiquée, sans qu'un avenant soit nécessaire.
Ajustement des coûts : les variations de coûts subies par VOLT. (concentrés, fournisseurs, transport, énergie, taxes et redevances publiques) sont répercutées sur la Salle, à la hausse comme à la baisse, y compris pendant la durée ferme. VOLT. en informe la Salle par écrit au moins 30 jours à l'avance, avec la justification de la variation ; le nouveau montant s'applique dès la date indiquée, sans qu'un avenant soit nécessaire.
En cas de reconduction, la clé de répartition peut être renégociée moyennant un préavis écrit de 3 mois.

5. Engagements de VOLT.
Livrer, installer et mettre en service la station, la tablette et le module de commande.
Former le personnel de la Salle à l'usage et à l'hygiène de la station.
Livrer les concentrés selon la consommation, sur commande de la Salle ou de manière planifiée.
Assurer un entretien technique sur place tous les 6 mois (nettoyage approfondi, détartrage, contrôle des réglages), consigné dans l'Espace fitness.
Fournir l'Espace fitness, son hébergement, ses mises à jour et un support par email sous 2 jours ouvrables ; intervenir en cas de panne sous [5] jours ouvrables.

6. Engagements de la Salle
Mettre à disposition un emplacement conforme au cahier des charges : eau potable, électricité, connexion internet.
Inscrire et tenir à jour ses membres dans l'Espace fitness (identité, téléphone, email, n° d'accès, dates d'abonnement, pauses, blocages).
Recharger les concentrés livrés, les stocker selon les consignes et réaliser l'autocontrôle quotidien et hebdomadaire (Annexe A).
Utiliser exclusivement les concentrés fournis par VOLT. et signaler sans délai tout dysfonctionnement, fuite ou anomalie.

7. Conditions générales
Propriété : le matériel reste la propriété exclusive de VOLT. La Salle s'interdit de le céder, le mettre en gage, le prêter à un tiers ou le déplacer sans accord écrit, et signale la propriété de VOLT. en cas de saisie ou de faillite.
Exclusivité : seuls les concentrés VOLT. peuvent être utilisés. Toute infraction entraîne une peine conventionnelle de 2'000.00 CHF et autorise une résiliation avec effet immédiat.
Garde et assurance : dès la signature du PV de réception, la Salle prend soin du matériel avec diligence (art. 306 CO), répond de la perte, du vol et des dommages non liés à l'usure normale, et l'assure pour sa valeur de remplacement.
Infrastructure : les raccordements à l'eau et à l'électricité sont à la charge de la Salle ; VOLT. décline toute responsabilité pour les dégâts liés à ces travaux.
Décomptes et paiements : la Salle transmet chaque mois le nombre de membres bénéficiant du service. Tout retard de versement de la part revenant à VOLT. porte intérêt à 5 % l'an (art. 104 CO) ; après un rappel resté sans effet pendant 10 jours, VOLT. peut suspendre la distribution.
Fermeture : en cas de fermeture volontaire, la part revenant à VOLT. reste calculée sur la moyenne des 6 derniers mois. En cas de fermeture imposée par les autorités de plus de 30 jours consécutifs, cette part est réduite de 50 % au-delà de ces 30 jours et la durée ferme est prolongée d'autant.
Responsabilité de VOLT. : limitée aux dommages directs, dans les limites de la loi ; exclue en cas de défaut d'autocontrôle ou de stockage de la Salle.

8. Protection des données
La Salle est responsable du traitement des données de ses membres ; VOLT. agit comme sous-traitant (art. 9 nLPD) et les traite uniquement pour autoriser la distribution, gérer l'accès, l'historique des passages et le support.
Données traitées : nom, prénom, téléphone, email, date de naissance (facultative), n° d'accès, dates et statut d'abonnement, historique des passages.
Hébergement chez Infomaniak (Suisse) et chez des prestataires techniques (dont Vercel, GitHub) offrant des garanties adéquates, y compris pour les transferts hors de Suisse. Aucune revente, aucune autre utilisation.
La Salle informe ses membres de cette transmission dans ses conditions d'abonnement et renvoie à volt-energy.ch/confidentialite. Le détail des passages est conservé 6 mois puis supprimé automatiquement ; seuls les totaux mensuels par salle sont gardés pour les décomptes. Les registres d'autocontrôle sont conservés 2 ans (obligation légale) ; à la fin du contrat, restitution sur demande puis suppression sous 30 jours.

9. Résiliation et fin du contrat
Résiliation anticipée par la Salle : indemnité forfaitaire égale à [50] % de la part mensuelle moyenne revenant à VOLT. (6 derniers mois), multipliée par le nombre de mois restants (art. 160 CO).
Manquement grave non corrigé dans les 30 jours suivant une mise en demeure écrite : résiliation possible avec effet immédiat par chaque partie.
Fin du contrat : restitution du matériel en bon état, sous réserve de l'usure normale (art. 309 CO) ; VOLT. procède à la désinstallation, la remise en état des raccordements reste à la charge de la Salle.

10. Dispositions finales
Les communications par email aux adresses des parties font foi ; résiliations et mises en demeure par écrit. Toute modification requiert la forme écrite. Si une clause devait être invalide, les autres restent applicables.
Droit suisse. For exclusif : Lausanne (Vaud).

Annexe A — Protocole d'autocontrôle et de stockage
Cadre légal : LDAl, ODAlOUs et OHyg. VOLT. n'étant pas présente au quotidien, la Salle assure sur place l'autocontrôle courant ; VOLT. assure l'entretien semestriel.
Chaque jour (personnel de la Salle) : nettoyer et désinfecter la buse, la grille et la zone de service ; vérifier l'absence de fuite, d'odeur ou de dépôt ; contrôler que la tablette affiche les saveurs et les allergènes ; consigner le contrôle (date, heure, visa).
Chaque semaine : nettoyer l'égouttoir et l'extérieur ; vérifier les dates d'ouverture des poches (à utiliser dans les 3 mois).
Stockage : poches fermées dans un local sec, à l'abri de la lumière, max. 25 °C, hors de portée du public ; « premier entré, premier sorti » ; noter la date d'ouverture et le n° de lot.
Filtre (si installé) : remplacement au minimum tous les 3 mois, assuré par VOLT.
Anomalie : mettre la station hors service, conserver la poche (n° de lot) et prévenir VOLT. le jour même.
Registres conservés au moins 2 ans dans l'Espace fitness et présentés sur demande à l'autorité cantonale de contrôle.
v2.0$ct$, encode(sha256(convert_to($ct$1. Parties
VOLT., entreprise individuelle exploitée par M. Reda Hassini, Rue de la Baumettaz 12, 1023 Crissier, IDE [CHE-___.___.___] (« VOLT. »).
la Salle — [raison sociale, IDE, adresse] (« la Salle »).

2. Objet
Dans le cadre d'un partenariat, VOLT. met à disposition de la Salle et maintient une station de boissons VOLT. Pro (concentrés en poches de 5 L), une tablette fixée à la station qui lit le badge et autorise la distribution, un module de commande (relais, contact sec), l'accès à l'Espace fitness et la livraison des concentrés.
Les membres se servent avec leur badge habituel, à raison d'une boisson toutes les 15 minutes. L'accès VOLT. est intégré à l'abonnement de la Salle, qui en fixe librement le prix. VOLT. ne facture rien aux membres.

3. Durée
Durée ferme de 36 mois (3 ans) à compter de la signature du procès-verbal de réception, puis renouvellement tacite par périodes de 12 mois, sauf résiliation écrite moyennant un préavis de 3 mois avant l'échéance.

4. Partage des revenus
VOLT. et la Salle se partagent les revenus générés par le service VOLT. inclus dans les abonnements de la Salle. 
Les modalités financières (clé de répartition, base de calcul, périodicité des décomptes, options telles que le filtre) sont convenues directement entre VOLT. et la Salle, par écrit (email ou offre signée).
VOLT. se réserve le droit d'ajuster ces modalités ainsi que les conditions d'exploitation du service (fréquence de livraison, assortiment des saveurs, réglages de la station). Elle en informe la Salle par écrit au moins 30 jours à l'avance, avec la justification ; les nouvelles conditions s'appliquent dès la date indiquée, sans qu'un avenant soit nécessaire.
Ajustement des coûts : les variations de coûts subies par VOLT. (concentrés, fournisseurs, transport, énergie, taxes et redevances publiques) sont répercutées sur la Salle, à la hausse comme à la baisse, y compris pendant la durée ferme. VOLT. en informe la Salle par écrit au moins 30 jours à l'avance, avec la justification de la variation ; le nouveau montant s'applique dès la date indiquée, sans qu'un avenant soit nécessaire.
En cas de reconduction, la clé de répartition peut être renégociée moyennant un préavis écrit de 3 mois.

5. Engagements de VOLT.
Livrer, installer et mettre en service la station, la tablette et le module de commande.
Former le personnel de la Salle à l'usage et à l'hygiène de la station.
Livrer les concentrés selon la consommation, sur commande de la Salle ou de manière planifiée.
Assurer un entretien technique sur place tous les 6 mois (nettoyage approfondi, détartrage, contrôle des réglages), consigné dans l'Espace fitness.
Fournir l'Espace fitness, son hébergement, ses mises à jour et un support par email sous 2 jours ouvrables ; intervenir en cas de panne sous [5] jours ouvrables.

6. Engagements de la Salle
Mettre à disposition un emplacement conforme au cahier des charges : eau potable, électricité, connexion internet.
Inscrire et tenir à jour ses membres dans l'Espace fitness (identité, téléphone, email, n° d'accès, dates d'abonnement, pauses, blocages).
Recharger les concentrés livrés, les stocker selon les consignes et réaliser l'autocontrôle quotidien et hebdomadaire (Annexe A).
Utiliser exclusivement les concentrés fournis par VOLT. et signaler sans délai tout dysfonctionnement, fuite ou anomalie.

7. Conditions générales
Propriété : le matériel reste la propriété exclusive de VOLT. La Salle s'interdit de le céder, le mettre en gage, le prêter à un tiers ou le déplacer sans accord écrit, et signale la propriété de VOLT. en cas de saisie ou de faillite.
Exclusivité : seuls les concentrés VOLT. peuvent être utilisés. Toute infraction entraîne une peine conventionnelle de 2'000.00 CHF et autorise une résiliation avec effet immédiat.
Garde et assurance : dès la signature du PV de réception, la Salle prend soin du matériel avec diligence (art. 306 CO), répond de la perte, du vol et des dommages non liés à l'usure normale, et l'assure pour sa valeur de remplacement.
Infrastructure : les raccordements à l'eau et à l'électricité sont à la charge de la Salle ; VOLT. décline toute responsabilité pour les dégâts liés à ces travaux.
Décomptes et paiements : la Salle transmet chaque mois le nombre de membres bénéficiant du service. Tout retard de versement de la part revenant à VOLT. porte intérêt à 5 % l'an (art. 104 CO) ; après un rappel resté sans effet pendant 10 jours, VOLT. peut suspendre la distribution.
Fermeture : en cas de fermeture volontaire, la part revenant à VOLT. reste calculée sur la moyenne des 6 derniers mois. En cas de fermeture imposée par les autorités de plus de 30 jours consécutifs, cette part est réduite de 50 % au-delà de ces 30 jours et la durée ferme est prolongée d'autant.
Responsabilité de VOLT. : limitée aux dommages directs, dans les limites de la loi ; exclue en cas de défaut d'autocontrôle ou de stockage de la Salle.

8. Protection des données
La Salle est responsable du traitement des données de ses membres ; VOLT. agit comme sous-traitant (art. 9 nLPD) et les traite uniquement pour autoriser la distribution, gérer l'accès, l'historique des passages et le support.
Données traitées : nom, prénom, téléphone, email, date de naissance (facultative), n° d'accès, dates et statut d'abonnement, historique des passages.
Hébergement chez Infomaniak (Suisse) et chez des prestataires techniques (dont Vercel, GitHub) offrant des garanties adéquates, y compris pour les transferts hors de Suisse. Aucune revente, aucune autre utilisation.
La Salle informe ses membres de cette transmission dans ses conditions d'abonnement et renvoie à volt-energy.ch/confidentialite. Le détail des passages est conservé 6 mois puis supprimé automatiquement ; seuls les totaux mensuels par salle sont gardés pour les décomptes. Les registres d'autocontrôle sont conservés 2 ans (obligation légale) ; à la fin du contrat, restitution sur demande puis suppression sous 30 jours.

9. Résiliation et fin du contrat
Résiliation anticipée par la Salle : indemnité forfaitaire égale à [50] % de la part mensuelle moyenne revenant à VOLT. (6 derniers mois), multipliée par le nombre de mois restants (art. 160 CO).
Manquement grave non corrigé dans les 30 jours suivant une mise en demeure écrite : résiliation possible avec effet immédiat par chaque partie.
Fin du contrat : restitution du matériel en bon état, sous réserve de l'usure normale (art. 309 CO) ; VOLT. procède à la désinstallation, la remise en état des raccordements reste à la charge de la Salle.

10. Dispositions finales
Les communications par email aux adresses des parties font foi ; résiliations et mises en demeure par écrit. Toute modification requiert la forme écrite. Si une clause devait être invalide, les autres restent applicables.
Droit suisse. For exclusif : Lausanne (Vaud).

Annexe A — Protocole d'autocontrôle et de stockage
Cadre légal : LDAl, ODAlOUs et OHyg. VOLT. n'étant pas présente au quotidien, la Salle assure sur place l'autocontrôle courant ; VOLT. assure l'entretien semestriel.
Chaque jour (personnel de la Salle) : nettoyer et désinfecter la buse, la grille et la zone de service ; vérifier l'absence de fuite, d'odeur ou de dépôt ; contrôler que la tablette affiche les saveurs et les allergènes ; consigner le contrôle (date, heure, visa).
Chaque semaine : nettoyer l'égouttoir et l'extérieur ; vérifier les dates d'ouverture des poches (à utiliser dans les 3 mois).
Stockage : poches fermées dans un local sec, à l'abri de la lumière, max. 25 °C, hors de portée du public ; « premier entré, premier sorti » ; noter la date d'ouverture et le n° de lot.
Filtre (si installé) : remplacement au minimum tous les 3 mois, assuré par VOLT.
Anomalie : mettre la station hors service, conserver la poche (n° de lot) et prévenir VOLT. le jour même.
Registres conservés au moins 2 ans dans l'Espace fitness et présentés sur demande à l'autorité cantonale de contrôle.
v2.0$ct$, 'UTF8')), 'hex'), true)
on conflict (version) do nothing;
