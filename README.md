# snipping_bot

Bot de sniping de nouveaux tokens Uniswap V3 sur **Base** (chainId 8453) : détection de création de pools en temps réel, évaluation du risque, achat automatique si les critères sont remplis, gestion de position (take-profit / stop-loss).

## Installation

```bash
npm install
cp .env.example .env
```

Remplir `.env` (voir les commentaires dans le fichier). Les secrets ne sont JAMAIS commités (`.env` est ignoré par git).

## Prérequis runtime

| Variable | Où l'obtenir |
|---|---|
| `BASE_WS_URL` | RPC WebSocket (QuickNode, Alchemy, PublicNode...) pour le listener |
| `BASE_RPC_URL` | RPC HTTPS privé/rapide pour l'exécution (le même fournisseur convient) |
| `BASESCAN_API_KEY` | Clé API V2 de [etherscan.io/my-api-key](https://etherscan.io/my-api-key). Basescan est opéré par Etherscan : un seul compte etherscan.io couvre toutes les chaînes (Base inclus, via `chainid=8453`) |
| `PRIVATE_KEY` | Clé privée d'un wallet **dédidé** au bot, financé en ETH sur Base |
| `DISCORD_WEBHOOK_URL` / `TELEGRAM_*` | Notifications (optionnel). Telegram : bot via @BotFather, puis `npx tsx scripts/telegram-setup.ts` pour obtenir le `TELEGRAM_CHAT_ID` |

## Utilisation

**1. Toujours commencer en dry-run** (défaut) :

```bash
npm start
```

En dry-run, tout le pipeline tourne pour de vrai (écoute, risk-checks, quotages) mais aucune transaction n'est envoyée : les achats/ventes sont simulés avec les quotes réelles et loggés.

**2. Passer en live** une fois le dry-run validé :

```bash
DRY_RUN=false npm start
```

## Taille de trade dynamique en dollars

Par défaut, le montant par trade est fixe (`TRADE_AMOUNT_ETH`). Pour limiter la perte unitaire en dollars — utile contre les honeypots d'où l'on ne sort jamais — activer le mode dynamique :

```
TRADE_AMOUNT_USD=5
ETH_PRICE_REFRESH_MINUTES=10
```

Le montant devient `5 $ / prix ETH`, prix lu on-chain via la pool WETH/USDC 0.05 % (QuoterV2, aucune clé API), rafraîchi toutes les 10 minutes et mis en cache. Garde-fou : si le montant calculé sort des bornes `[0.0001 ; 0.1]` ETH (prix aberrant), l'achat est bloqué et signalé. `TRADE_AMOUNT_USD` est prioritaire sur `TRADE_AMOUNT_ETH`.

## Pipeline

```
PoolCreated (factory V3, WebSocket)
  └─ filtre WETH/USDC natif
      └─ guardrails (budget par trade, budget journalier, positions max)
          └─ risk-check (contrat vérifié, fonctions dangereuses, ownership,
             liquidité, honeypot par quotage aller-retour, holders)
              └─ achat (SwapRouter02 direct ou contrat helper)
                  └─ position-manager (take-profit / stop-loss/urgence)
```

Un achat exige des risk-checks favorables, sans exception. Budget journalier atteint = arrêt automatique du bot.

## Extension possible : module Jev (non inclus)

Le module Jev n'est pas implémenté aujourd'hui. S'il est ajouté, il se branchera **entre le risk-check et l'exécution** : il recevrait le rapport de risque (checks passés/échoués, liquidité, rétention aller-retour, concentration des holders) et répondrait par un jugement probabiliste — la primitive Noul du modèle Jev de TypeSafe — à la question « est-ce un risque calculé acceptable pour une petite position fixe ? ». L'achat ne partirait alors que si la probabilité dépasse un seuil configurable (ex. `MIN_JEV_BUY_PROBABILITY=0.6`). Le skill `typesafe-ai` (installé globalement sur la machine) documente l'API et les patterns d'intégration.

## Contrat helper (optionnel)

`contracts/MultiHopSwap.sol` est le helper non-custodial adapté à SwapRouter02 (Base). Sans `HELPER_CONTRACT_ADDRESS`, le bot opère en mode routeur direct (WETH + approbations au SwapRouter02 officiel), ce qui fonctionne sans déploiement.

Déploiement du helper (Foundry/Hardhat/Remix), arguments du constructor :
- router : `0x2626664c2603336E57B271c5C0b26F421741e481` (SwapRouter02, Base)
- weth : `0x4200000000000000000000000000000000000006` (WETH9)

Le contrat n'a ni owner, ni pause, ni fonction de retrait : ne jamais en ajouter.

## Déploiement Docker / Dokploy

Le projet inclut `Dockerfile`, `docker-compose.yml` et `.dockerignore`. Le service est un worker sans port web.

### Dokploy (service de type Compose)

1. Mettre le projet dans un dépôt git. Ne **jamais** commiter `.env`.
2. Dokploy : nouveau projet, puis service de type **Compose** pointant sur le dépôt.
3. Coller les variables d'environnement dans l'interface Dokploy (mêmes noms que `.env.example`) : Dokploy les écrit dans un `.env` au moment du déploiement, chargé par le compose via `env_file`.
4. Déployer. Le mode reste `DRY_RUN=true` tant que la variable n'est pas changée.

### Docker en local

```bash
docker compose up -d --build
docker logs -f snipping-bot                         # suivi temps réel
docker exec snipping-bot sh -c "tail -f logs/*.log" # fichier de log persistant
docker compose down                                  # stop -> SIGTERM -> arrêt propre tracé
```

Les fichiers `logs/bot-*.log` persistent dans le volume Docker `bot-logs` entre les redémarrages et les redéploiements. La clé privée n'est jamais incluse dans l'image : elle ne vit que dans les variables d'environnement du conteneur.

## Tests

```bash
npm test        # vitest, tous les modules
npm run build   # tsc
```

## Logs

Logs JSON ligne par ligne sur stdout et dans `logs/bot-YYYY-MM-DD.log` : chaque décision (pool détectée, checks, action, résultat) est tracée.

## Sécurité

- Clé privée d'un wallet dédié, jamais le wallet principal.
- `amountIn` fixe par trade (`TRADE_AMOUNT_ETH`), jamais "tout le solde".
- `amountOutMin` calculé dynamiquement depuis un quote frais avec le slippage configuré.
- Mode dry-run obligatoire pour valider tout nouveau comportement avant le live.
