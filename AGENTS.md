# AGENTS.md - snipping_bot

## Contexte projet

Bot de sniping de nouveaux tokens Uniswap V3 sur **Base** (chainId 8453) : détection de création de pools en temps réel, évaluation rapide du risque, achat automatique si les critères sont remplis, gestion de position (take-profit / stop-loss).

Etat du dépôt : implémenté et fonctionnel. Contrat dans `contracts/`, bot TypeScript dans `src/` (un module par fichier), tests vitest dans `test/`. Commandes : `npm test` (vitest), `npm run typecheck` (tsc strict), `npm start` (dry-run par défaut, `DRY_RUN=false` pour le live).

**Workflow imposé par l'utilisateur** : pour toute nouvelle brique, proposer les changements d'architecture et les interfaces, les faire valider par l'utilisateur, PUIS écrire le code.

## Architecture cible

- `contracts/` : smart contract Solidity, adaptation du contrat `MultiHopSwap` fourni par l'utilisateur (helper de swap Uniswap V3 non-custodial) avec les adresses Base.
- Bot off-chain TypeScript + viem, un module par fichier, chacun testable indépendamment :
  - `listener` : écoute l'event `PoolCreated` de la factory V3 via WebSocket RPC (jamais de polling). Filtre : la paire doit inclure WETH ou USDC natif.
  - `risk-check` : contrat token vérifié (API Basescan), ownership renoncé / absence de fonctions mint et blacklist, simulation de vente via `eth_call` avant achat (anti-honeypot), liquidité initiale au-dessus d'un seuil configurable, répartition des holders (aucun wallet avec plus de 50% du supply hors pool).
  - `execution` : construit la transaction d'achat (`swapExactInputSingle` ou `swapExactInputMultihop`), soumise via un RPC privé rapide.
  - `position-manager` : take-profit et stop-loss configurables, surveille le prix et déclenche la vente automatique.
  - `guardrails` : budget max par trade (environ 0,05 ETH), budget journalier total avec arrêt automatique du bot, nombre max de positions simultanées.
  - `logger` / `notifier` : log structuré JSON de chaque décision (pool détectée, checks, action, résultat) + webhook Discord/Telegram.

## Skills du projet

- `swap-integration` (officiel Uniswap, installé globalement sur la machine dans `~/.agents/skills/swap-integration/`) : à charger pour toute tâche d'intégration swap (adaptation du contrat, module `execution`, quotage). Son guide privilégie la Trading API pour les bots ; l'architecture validée ici passe par des appels on-chain au routeur pour la latence. Utiliser le skill pour ses patterns d'intégration, pas pour re-diriger l'architecture.
- `typesafe-ai` (installé globalement) : à charger si le module optionnel `jev-decision` (jugement probabiliste entre risk-check et exécution, non implémenté) est ajouté un jour.

## Adresses vérifiées - Base mainnet (8453)

| Contrat | Adresse |
|---|---|
| UniswapV3Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| SwapRouter02 (routeur officiel) | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| WETH9 (predeploy canonique) | `0x4200000000000000000000000000000000000006` |
| USDC natif | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

- Ne pas confondre USDC natif et USDbC bridgé (`0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`) : le filtre WETH/USDC cible l'USDC natif.
- Base Sepolia (84532) pour les tests : factory `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`, SwapRouter02 `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`, QuoterV2 `0xC5290058841028F1614F3A6F0F5816cAd0df5E27`. WETH9 identique au mainnet.
- Sources : developers.uniswap.org (page deployments V3 Base) et docs.base.org. Les adresses V3 ne sont PAS identiques à celles d'Ethereum mainnet : ne jamais les copier depuis mainnet.

## Piège critique : interface du routeur

Le contrat `MultiHopSwap` fourni cible l'ancien SwapRouter, dont la struct `ExactInputSingleParams` contient un champ `deadline`. Le routeur officiel sur Base est **SwapRouter02** : sa struct `exactInputSingle` n'a **pas** de champ `deadline` (la deadline se gère via l'appel `deadline()` en multicall, ou côté appelant).

Adaptation requise : retirer `deadline` des structs de l'interface locale et conserver la validation de deadline dans le contrat (la fonction `_validate` existe déjà). Le routeur tire les tokens de son `msg.sender` (le contrat), le schéma `forceApprove` reste valable. Un contrat existe à l'adresse historique `0xE592427A0AEce92De3Edee1F18E0157C05861564` sur Base mais ce n'est pas le déploiement officiel documenté : ne pas l'utiliser sans re-vérification.

## Contraintes techniques

- Node.js 20+, TypeScript, **viem** (pas ethers.js).
- Secrets (clé privée, clés API, webhooks) : uniquement en variables d'environnement, jamais en dur, jamais commités.
- Listener : WebSocket RPC temps réel. Exécution : RPC privé rapide, pas d'endpoint public gratuit.
- Slippage max configurable (ex. 5%) : `amountOutMin` calculé dynamiquement par le bot off-chain, jamais codé en dur dans le contrat.
- `amountIn` fixe et configurable par trade, jamais "tout le solde".
- Deadline courte (ex. 2 minutes).

## Règles non négociables

- Contrat **non-custodial** : pas d'owner, pas de fonction de retrait privilégiée, pas de pause, pas de rescue. Ne jamais en ajouter.
- Mode **dry-run** activable par variable d'environnement : tout nouveau chemin d'exécution doit être testé en dry-run avant tout envoi réel.
- Un achat nécessite : risk-checks on-chain passés, sans exception.
- Aucun trade si un guardrail est violé (budget par trade, budget journalier, positions max). Budget journalier atteint = arrêt automatique du bot.
- L'utilisateur communique en français.
