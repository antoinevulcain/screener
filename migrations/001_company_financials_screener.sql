-- migrations/data/005_company_financials_screener.sql
-- DRAFT — denormalized screener table.
-- One row per (siren, exercise_year). Built nightly from
-- inpi_financial_statements_{ftp,api,ex} merged view + sirene context.
-- Columns:
--   * Identity / sirene context
--   * 5 typed KPIs + their YoY %, YoY abs, CAGR 3y/5y
--   * 355 cerfa-coded line items (current year value, N-1 value, YoY %)
--   * 30 financial ratios (margins, rentability, liquidity, leverage, productivity)
--   * Boolean screening flags (high-growth, distressed, loss-making, etc.)

CREATE TABLE IF NOT EXISTS company_financials_screener (
  -- ── Identity ───────────────────────────────────────────
  siren            VARCHAR(9)  NOT NULL,
  exercise_year    SMALLINT    NOT NULL,
  date_cloture     DATE        NOT NULL,
  duree_exercice_mois SMALLINT,
  type_comptes     VARCHAR(20),
  type_bilan       VARCHAR(8),                              -- 'RN' (régime normal) | 'RS' (simplifié) | 'CONSO'
  is_confidential  BOOLEAN     NOT NULL DEFAULT false,
  is_short_exercise BOOLEAN    NOT NULL DEFAULT false,      -- duree_exercice ≠ 12 months
  source           VARCHAR(20) NOT NULL,                    -- 'rne' | 'ocr' | 'mixed'

  -- ── Sirene context (denormalized for index-only filtering) ─
  naf_code         VARCHAR(8),
  naf_section      CHAR(1),
  forme_juridique  VARCHAR(4),
  effectif_tranche VARCHAR(4),
  region_code      VARCHAR(3),
  departement      VARCHAR(3),
  insee_commune    VARCHAR(5),
  date_creation    DATE,
  age_years        SMALLINT,
  display_denomination TEXT,

  -- ── Headline KPIs (typed) ──────────────────────────────
  chiffre_affaires       BIGINT,
  resultat_net           BIGINT,
  total_bilan            BIGINT,
  capitaux_propres       BIGINT,
  effectif_moyen         INTEGER,

  -- N-1 values for KPIs (from current row, source: liasse N/N-1 columns)
  chiffre_affaires_n1    BIGINT,
  resultat_net_n1        BIGINT,
  total_bilan_n1         BIGINT,
  capitaux_propres_n1    BIGINT,
  effectif_moyen_n1      INTEGER,

  -- YoY % vs N-1 (NULL when divisor is 0/negative or missing)
  chiffre_affaires_yoy_pct  REAL,
  resultat_net_yoy_pct      REAL,
  total_bilan_yoy_pct       REAL,
  capitaux_propres_yoy_pct  REAL,
  effectif_yoy_pct          REAL,

  -- YoY absolute change vs N-1
  chiffre_affaires_yoy_abs  BIGINT,
  resultat_net_yoy_abs      BIGINT,
  total_bilan_yoy_abs       BIGINT,
  capitaux_propres_yoy_abs  BIGINT,

  -- Multi-year CAGR (3y and 5y), computed across the company's series
  chiffre_affaires_cagr_3y_pct  REAL,
  chiffre_affaires_cagr_5y_pct  REAL,
  resultat_net_cagr_3y_pct      REAL,
  resultat_net_cagr_5y_pct      REAL,
  effectif_cagr_3y_pct          REAL,

  -- Annualized when duree_exercice ≠ 12 months
  chiffre_affaires_annualise BIGINT,
  resultat_net_annualise     BIGINT,

  -- ── Computed financial indicators ──────────────────────
  valeur_ajoutee         BIGINT,
  ebe                    BIGINT,                  -- excédent brut d'exploitation
  ebitda                 BIGINT,                  -- ~= REX + dotations
  caf                    BIGINT,                  -- capacité d'autofinancement
  bfr                    BIGINT,                  -- besoin en fonds de roulement
  fonds_roulement        BIGINT,                  -- FR
  tresorerie_nette       BIGINT,                  -- FR - BFR

  -- ── Financial ratios (REAL; NULL when divisor invalid) ──
  marge_brute_pct           REAL,
  marge_commerciale_pct     REAL,
  marge_production_pct      REAL,
  marge_exploitation_pct    REAL,
  marge_nette_pct           REAL,
  marge_ebe_pct             REAL,
  marge_ebitda_pct          REAL,
  taux_va_pct               REAL,                 -- VA / production

  roa_pct                   REAL,                 -- résultat_net / total_bilan
  roe_pct                   REAL,                 -- résultat_net / capitaux_propres
  roic_pct                  REAL,                 -- REX × (1-IS) / capitaux_employés
  roce_pct                  REAL,                 -- REX / capitaux_employés

  autonomie_financiere_pct  REAL,                 -- capitaux_propres / total_bilan
  taux_endettement_pct      REAL,                 -- dettes_financières / capitaux_propres (gearing)
  taux_endettement_global_pct REAL,               -- total_dettes / total_bilan
  capacite_remboursement_ans REAL,                -- dettes_financières / CAF
  couverture_charges_fin     REAL,                -- REX / charges_financières

  liquidite_generale        REAL,                 -- actif_circulant / dettes_court_terme
  liquidite_reduite         REAL,                 -- (créances+dispos) / dettes_CT
  liquidite_immediate       REAL,                 -- dispos / dettes_CT

  bfr_jours_ca              REAL,                 -- BFR × 365 / CA
  dso_jours                 REAL,                 -- (clients × 365) / CA
  dpo_jours                 REAL,                 -- (fournisseurs × 365) / achats
  rotation_stocks_jours     REAL,

  ca_par_salarie            BIGINT,
  va_par_salarie            BIGINT,
  resultat_par_salarie      BIGINT,

  poids_masse_salariale_pct REAL,
  poids_dotations_pct       REAL,
  poids_charges_externes_pct REAL,

  -- ── Boolean screening flags (cheap to partial-index) ───
  is_loss_making              BOOLEAN,            -- résultat_net < 0
  is_loss_making_3y           BOOLEAN,            -- 3 années consécutives de pertes
  has_grown_3y                BOOLEAN,            -- CA en hausse 3 ans de suite
  is_high_growth              BOOLEAN,            -- ca_yoy_pct ≥ 30% AND ca ≥ 1M€
  is_distressed               BOOLEAN,            -- capitaux_propres < capital_social/2 OR liquidite_generale < 1
  is_zombie                   BOOLEAN,            -- REX < charges_financières 3 ans
  swung_to_profit             BOOLEAN,            -- N-1 < 0 AND N > 0
  swung_to_loss               BOOLEAN,            -- N-1 > 0 AND N < 0

  -- ── Cerfa-coded line items (355 columns) ──
  -- Every code observed in the sample inventory. NULL when the code
  -- is not present on this row (régime simplifié uses 3-digit codes,
  -- régime normal uses 2-letter codes — both columns coexist; only the
  -- relevant set is populated per row).
  -- Column naming: c_<CODE> = year N value, c_<CODE>_n1 = N-1 value,
  -- c_<CODE>_yoy_pct = (N − N−1) / |N−1| × 100.
  c_ee          BIGINT,  -- TOTAL GENERAL (I à V)
  c_co          BIGINT,  -- TOTAL GENERAL (0 à V)
  c_dl          BIGINT,  -- TOTAL (I)
  c_cj          BIGINT,  -- TOTAL (II)
  c_da          BIGINT,  -- Capital social ou individuel
  c_di          BIGINT,  -- RESULTAT DE L’EXERCICE (bénéfice ou perte)
  c_ec          BIGINT,  -- TOTAL (IV)
  c_cf          BIGINT,  -- Disponibilités
  c_bj          BIGINT,  -- TOTAL (I)
  c_bz          BIGINT,  -- Autres créances
  c_dx          BIGINT,  -- Dettes fournisseurs et comptes rattachés
  c_dy          BIGINT,  -- Dettes fiscales et sociales
  c_dv          BIGINT,  -- Emprunts et dettes financières divers (4)
  c_gf          BIGINT,  -- Total des charges d’exploitation (II)
  c_gw          BIGINT,  -- RESULTAT COURANT AVANT IMPOTS (I - II + III - IV + V - VI)
  c_gg          BIGINT,  -- RESULTAT D’EXPLOITATION (I - II)
  c_hm          BIGINT,  -- TOTAL DES CHARGES (II + IV + VI + VIII + IX + X)
  c_at          BIGINT,  -- Autres immobilisations corporelles
  c_hn          BIGINT,  -- BENEFICE OU PERTE (Total des produits - Total des charges)
  c_fw          BIGINT,  -- Autres achats et charges externes
  c_bx          BIGINT,  -- Clients et comptes rattachés
  c_dd          BIGINT,  -- Réserve légale (1)
  c_hl          BIGINT,  -- TOTAL DES PRODUITS (I + III + V + VII)
  c_ea          BIGINT,  -- Autres dettes
  c_vy          BIGINT,  -- TOTAL – ETAT DES DETTES
  c_fr          BIGINT,  -- Total des produits d’exploitation (I)
  c_ch          BIGINT,  -- Charges constatées d’avance
  c_vt          BIGINT,  -- TOTAL – ETAT DES CREANCES
  c_eg          BIGINT,  -- Dettes et produits constatés d’avance à moins d’un an
  c_du          BIGINT,  -- Emprunts et dettes auprès des établissements de crédit (3)
  c_8b          BIGINT,  -- Fournisseurs et comptes rattachés
  c_fj          BIGINT,  -- Chiffres d’affaires nets
  c_gv          BIGINT,  -- RESULTAT FINANCIER (V - VI)
  c_fx          BIGINT,  -- Impôts, taxes et versements assimilés
  c_0g          BIGINT,  -- ACQUISITIONS Total Général
  c_i4          BIGINT,  -- DIMINUTIONS Total Général
  c_bh          BIGINT,  -- Autres immobilisations financières
  c_0n          BIGINT,  -- AMORTISSEMENTS Total Général
  c_qu          BIGINT,  -- AMORTISSEMENTS Total Immobilisations corporelles
  c_dg          BIGINT,  -- Autres réserves
  c_dh          BIGINT,  -- Report à nouveau
  c_ar          BIGINT,  -- Installations techniques, matériel et outillage industriels
  c_ge          BIGINT,  -- Autres charges
  c_ga          BIGINT,  -- Dot. d’exploit. - Dotations aux amortissements
  c_ln          BIGINT,  -- ACQUISITIONS Total Immobilisations corporelles
  c_iy          BIGINT,  -- DIMINUTIONS Total Immobilisations corporelles
  c_lq          BIGINT,  -- ACQUISITIONS Total Immobilisations financières
  c_fq          BIGINT,  -- Autres produits
  c_i3          BIGINT,  -- DIMINUTIONS Total Immobilisations financières
  c_fg          BIGINT,  -- Production vendue services
  c_gu          BIGINT,  -- Total des charges financières (VI)
  c_ux          BIGINT,  -- Autres créances clients
  c_gp          BIGINT,  -- Total des produits financiers (V)
  c_hk          BIGINT,  -- Impôts sur les bénéfices (X)
  c_vs          BIGINT,  -- Charges constatées d’avance
  c_fz          BIGINT,  -- Charges sociales
  c_fy          BIGINT,  -- Salaires et traitements
  c_hi          BIGINT,  -- RESULTAT EXCEPTIONNEL (VII - VIII)
  c_8d          BIGINT,  -- Sécurité sociale et autres organismes sociaux
  c_gr          BIGINT,  -- Intérêts et charges assimilées
  c_8k          BIGINT,  -- Autres dettes (dont dettes relatives à des opérations de pen
  c_hh          BIGINT,  -- Total des charges exceptionnelles (VIII)
  c_af          BIGINT,  -- Concessions, brevets et droits similaires
  c_vb          BIGINT,  -- T. V. A.
  c_vq          BIGINT,  -- Autres impôts, taxes et assimilés
  c_vi          BIGINT,  -- Groupe et associés
  c_vr          BIGINT,  -- Débiteurs divers (dont créances relatives à des opérations d
  c_vw          BIGINT,  -- T.V.A.
  c_io          BIGINT,  -- DIMINUTIONS Total dont autres postes d’immobilisations incor
  c_kd          BIGINT,  -- ACQUISITIONS Total dont autres postes d’immobilisations inco
  c_ut          BIGINT,  -- Autres immobilisations financières
  c_pe          BIGINT,  -- AMORTISSEMENTS Total dont autres immobilisations incorporell
  c_hd          BIGINT,  -- Total des produits exceptionnels (VII)
  c_8c          BIGINT,  -- Personnel et comptes rattachés
  c_fp          BIGINT,  -- Reprises sur amortissements et provisions, transfert de char
  c_cu          BIGINT,  -- Autres participations
  c_gl          BIGINT,  -- Autres intérêts et produits assimilés
  c_ah          BIGINT,  -- Fonds commercial
  c_180          BIGINT,  -- Total général Passif
  c_he          BIGINT,  -- Charges exceptionnelles sur opérations de gestion
  c_110          BIGINT,  -- Total général Actif
  c_142          BIGINT,  -- Total des capitaux propres - Total I
  c_096          BIGINT,  -- Total Actif circulant + Charges constatées d’avance
  c_120          BIGINT,  -- Capital social ou individuel
  c_7c          BIGINT,  -- TOTAL GENERAL
  c_136          BIGINT,  -- Résultat de l’exercice
  c_084          BIGINT,  -- Disponibilités
  c_bt          BIGINT,  -- Marchandises
  c_176          BIGINT,  -- Total des dettes
  c_vh          BIGINT,  -- Emprunts à plus d’1 an à l’origine
  c_ap          BIGINT,  -- Constructions
  c_vg          BIGINT,  -- Emprunts à 1 an maximum à l’origine
  c_vk          BIGINT,  -- Emprunts remboursés en cours d’exercice
  c_172          BIGINT,  -- Autres dettes
  c_fu          BIGINT,  -- Achats de matières premières et autres approvisionnements
  c_264          BIGINT,  -- Total des charges d’exploitation
  c_310          BIGINT,  -- Bénéfice ou perte
  c_270          BIGINT,  -- Résultat d’exploitation
  c_fs          BIGINT,  -- Achats de marchandises (y compris droits de douane)
  c_242          BIGINT,  -- Autres charges externes*
  c_bl          BIGINT,  -- Matières premières, approvisionnements
  c_7b          BIGINT,  -- Total Provisions pour dépréciation
  c_fa          BIGINT,  -- Ventes de marchandises
  c_044          BIGINT,  -- Total Actif Immobilisé
  c_hb          BIGINT,  -- Produits exceptionnels sur opérations en capital
  c_072          BIGINT,  -- Créances – Autres
  c_232          BIGINT,  -- Total des produits d’exploitation hors T.V.A.
  c_cd          BIGINT,  -- Valeurs mobilières de placement
  c_ha          BIGINT,  -- Produits exceptionnels sur opérations de gestion
  c_bv          BIGINT,  -- Avances et acomptes versés sur commandes
  c_bd          BIGINT,  -- Autres titres immobilisés
  c_6t          BIGINT,  -- Sur comptes clients
  c_166          BIGINT,  -- Fournisseurs et comptes rattachés
  c_hf          BIGINT,  -- Charges exceptionnelles sur opérations en capital
  c_eh          BIGINT,  -- Dont concours bancaires courants, et soldes créditeurs de ba
  c_dw          BIGINT,  -- Avances et acomptes reçus sur commandes en cours
  c_ue          BIGINT,  -- dont dotations et reprises : - d’Exploitation
  c_ft          BIGINT,  -- Variation de stock (marchandises)
  c_gc          BIGINT,  -- Dot. d’exploit. Sur actif circulant : dotations aux provisio
  c_va          BIGINT,  -- Clients douteux ou litigieux
  c_vm          BIGINT,  -- Impôts sur les bénéfices
  c_dr          BIGINT,  -- TOTAL (III)
  c_fo          BIGINT,  -- Subventions d’exploitation
  c_028          BIGINT,  -- Immobilisations corporelles
  c_ei          BIGINT,  -- Dont emprunts participatifs
  c_218          BIGINT,  -- Production vendue de services - France
  c_134          BIGINT,  -- Report à nouveau
  c_eb          BIGINT,  -- Produits constatés d’avance (2)
  c_fv          BIGINT,  -- Variation de stock (matières premières et approvisionnements
  c_uy          BIGINT,  -- Personnel et comptes rattachés
  c_vc          BIGINT,  -- Groupe et associés
  c_244          BIGINT,  -- Impôts, taxes et versements assimilés
  c_vj          BIGINT,  -- Emprunts souscrits en cours d’exercice
  c_8a          BIGINT,  -- Emprunts et dettes financières divers
  c_gj          BIGINT,  -- Produits financiers de participations
  c_fd          BIGINT,  -- Production vendue biens
  c_5z          BIGINT,  -- Total Provisions pour risques et charges
  c_dp          BIGINT,  -- Provisions pour risques
  c_an          BIGINT,  -- Terrains
  c_a1          BIGINT,  -- ACTIF - Créances sur les Ets de crédit
  c_8e          BIGINT,  -- Impôts sur les bénéfices
  c_254          BIGINT,  -- Dotations aux amortissements
  c_yp          BIGINT,  -- Effectif moyen du personnel
  c_040          BIGINT,  -- Immobilisations financières
  c_cp          BIGINT,  -- Parts à moins d’un an
  c_db          BIGINT,  -- Primes d’émission, de fusion, d’apport, …
  c_068          BIGINT,  -- Créances – Clients et comptes rattachés
  c_vp          BIGINT,  -- Divers
  c_306          BIGINT,  -- Impôts sur les bénéfices
  c_126          BIGINT,  -- Réserve légale
  c_252          BIGINT,  -- Charges sociales
  c_169          BIGINT,  -- Autres dettes dont comptes courant d’associés de l’exercice 
  c_250          BIGINT,  -- Rémunérations du personnel
  c_aj          BIGINT,  -- Autres immobilisations incorporelles
  c_8l          BIGINT,  -- Produits constatés d’avance
  c_230          BIGINT,  -- Autres produits
  c_262          BIGINT,  -- Autres charges
  c_uz          BIGINT,  -- Sécurité Sociale, autres organismes sociaux
  c_zj          BIGINT,  -- Total du poste correspondant à la ligne FW du tableau n° 205
  c_av          BIGINT,  -- Immobilisations en cours
  c_hp          BIGINT,  -- Renvois : Crédit-bail mobilier
  c_st          BIGINT,  -- Autres comptes
  c_fm          BIGINT,  -- Production stockée
  c_294          BIGINT,  -- Charges financières
  c_ss          BIGINT,  -- Rémunération d’intermédiaires et honoraires (hors rétrocessi
  c_490          BIGINT,  -- Total Immobilisations (Valeur brute)
  c_yx          BIGINT,  -- Total du compte correspondant à la ligne FX du tableau n° 20
  c_yz          BIGINT,  -- Total TVA. déductible sur biens et services
  c_182          BIGINT,  -- Coût de revient des immobilisations acquises ou créées au co
  c_156          BIGINT,  -- Emprunts et dettes assimilées
  c_9z          BIGINT,  -- Autres impôts, taxes et versements assimilés
  c_yy          BIGINT,  -- Montant de la TVA. collectée
  c_bn          BIGINT,  -- En cours de production de biens
  c_xq          BIGINT,  -- Location, charges locatives et de copropriété
  c_yw          BIGINT,  -- Taxe professionnelle
  c_dz          BIGINT,  -- Dettes sur immobilisations et comptes rattachés
  c_378          BIGINT,  -- Montant de la T.V.A. déductible sur biens et services
  c_bb          BIGINT,  -- Créances rattachées à des participations
  c_gd          BIGINT,  -- Dot. d’exploit. Pour risques et charges : dotations aux prov
  c_300          BIGINT,  -- Charges exceptionnelles
  c_234          BIGINT,  -- Achats de marchandises (y compris droits de douane)
  c_hg          BIGINT,  -- Dotations exceptionnelles aux amortissements et provisions
  c_374          BIGINT,  -- Montant de la T.V.A. collectée
  c_yt          BIGINT,  -- Sous-traitance
  c_6n          BIGINT,  -- Sur stocks et en cours
  c_092          BIGINT,  -- Charges constatées d’avance
  c_132          BIGINT,  -- Autres réserves
  c_cs          BIGINT,  -- Participations évaluées - mise en équivalence
  c_238          BIGINT,  -- Achats de matières premières et autres approvisionnements (y
  c_a4          BIGINT,  -- Renvois : Redevances pour concessions de brevets, de licence
  c_hc          BIGINT,  -- Reprises sur provisions et transferts de charges
  c_243          BIGINT,  -- (dont taxe professionnelle)
  c_280          BIGINT,  -- Produits financiers
  c_bf          BIGINT,  -- Prêts
  c_dq          BIGINT,  -- Provisions pour charges
  c_492          BIGINT,  -- Total Immobilisations (Augmentations)
  c_060          BIGINT,  -- Stock marchandises
  c_5v          BIGINT,  -- Autres provisions pour risques et charges
  c_gq          BIGINT,  -- Dotations financières sur amortissements et provisions
  c_dk          BIGINT,  -- Provisions réglementées
  c_ul          BIGINT,  -- Créances rattachées à des participations
  c_br          BIGINT,  -- Produits intermédiaires et finis
  c_4a          BIGINT,  -- Provisions pour litiges
  c_gk          BIGINT,  -- Produits des autres valeurs mobilières et créances de l’acti
  c_uj          BIGINT,  -- dont dotations et reprises : - Exceptionnelles
  c_014          BIGINT,  -- Immobilisations incorporelles – Autres
  c_ax          BIGINT,  -- Avances et acomptes
  c_210          BIGINT,  -- Ventes de marchandises – France
  c_8j          BIGINT,  -- Dettes sur immobilisations et comptes rattachés
  c_gn          BIGINT,  -- Différences positives de change
  c_dj          BIGINT,  -- Subventions d’investissement
  c_gs          BIGINT,  -- Différences négatives de change
  c_up          BIGINT,  -- Prêts
  c_3z          BIGINT,  -- Total Provisions réglementées
  c_cr          BIGINT,  -- Parts à plus d’un an
  c_de          BIGINT,  -- Réserves statutaires ou contractuelles
  c_hj          BIGINT,  -- Participation des salariés aux résultats de l’entreprise (IX
  c_a2          BIGINT,  -- ACTIF - Créances sur la clientèle
  c_195          BIGINT,  -- Dont dettes à plus d’un an
  c_ug          BIGINT,  -- dont dotations et reprises : - Financières
  c_236          BIGINT,  -- Variation de stock (marchandises)
  c_290          BIGINT,  -- Produits exceptionnels
  c_gm          BIGINT,  -- Reprises sur provisions et transferts de charges
  c_3x          BIGINT,  -- Amortissements dérogatoires
  c_cy          BIGINT,  -- AMORTISSEMENTS Frais d’établissement, et de développement ou
  c_bp          BIGINT,  -- En cours de production de services
  c_fn          BIGINT,  -- Production immobilisée
  c_i2          BIGINT,  -- DIMINUTIONS Prêts et immobilisations financières
  c_in          BIGINT,  -- DIMINUTIONS Frais d’établissement, et de développement ou de
  c_yu          BIGINT,  -- Personnel extérieur à l’entreprise
  c_cz          BIGINT,  -- ACQUISITIONS Frais d’établissement, et de développement ou d
  c_go          BIGINT,  -- Produits nets sur cessions de valeurs mobilières de placemen
  c_ab          BIGINT,  -- Frais d’établissement
  c_vn          BIGINT,  -- Autres impôts, taxes versements assimilés
  c_gb          BIGINT,  -- Dot. d’exploit. - Dotations aux provisions
  c_010          BIGINT,  -- Immobilisations incorporelles - Fonds commercial
  c_ze          BIGINT,  -- Dividendes
  c_6x          BIGINT,  -- Autres provisions pour dépréciation
  c_df          BIGINT,  -- Réserves réglementées (1)
  c_9u          BIGINT,  -- sur immobilisations – titres de participation
  c_050          BIGINT,  -- Matières premières, approvisionnements, en cours de producti
  c_080          BIGINT,  -- Valeurs mobilières de placement
  c_494          BIGINT,  -- Total Immobilisations (Diminutions)
  c_376          BIGINT,  -- Effectif moyen du personnel
  c_472          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Autres immobilisations corp
  c_482          BIGINT,  -- AUGMENTATIONS Immobilisations financières
  c_4x          BIGINT,  -- Provisions pour pensions et obligations similaires
  c_442          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Installations techniques ma
  c_cx          BIGINT,  -- Frais de développement ou de recherche et développement
  c_174          BIGINT,  -- Produits constatés d’avance
  c_gt          BIGINT,  -- Charges nettes sur cessions de valeurs mobilières de placeme
  c_240          BIGINT,  -- Variation de stock (matières premières et approvisionnement)
  c_462          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Matériel de transport
  c_yq          BIGINT,  -- Engagement de crédit-bail mobilier
  c_eo          BIGINT,  -- Provisions pour gros entretien et grandes révisions ou gross
  c_199          BIGINT,  -- Dont comptes courant d’associés débiteurs
  c_ed          BIGINT,  -- (V)
  c_064          BIGINT,  -- Avances et acomptes versés sur commandes
  c_214          BIGINT,  -- Production vendue de biens – France
  c_gh          BIGINT,  -- Bénéfice attribué ou perte transférée (III)
  c_226          BIGINT,  -- Subventions d’exploitation reçues
  c_hq          BIGINT,  -- Renvois : Crédit-bail immobilier
  c_gi          BIGINT,  -- Perte supportée ou bénéfice transféré (IV)
  c_cn          BIGINT,  -- Ecarts de conversion actif (V)
  c_184          BIGINT,  -- Prix de vente hors T.V.A. des immobilisations cédées au cour
  c_06          BIGINT,  -- sur immobilisations – autres immobilisations financières
  c_4e          BIGINT,  -- Provisions pour garanties données aux clients
  c_yv          BIGINT,  -- Rétrocessions d’honoraires, commissions et courtages
  c_a3          BIGINT,  -- Renvois : Redevances pour concessions de brevets, de licence
  c_dc          BIGINT,  -- Ecarts de réévaluation
  c_164          BIGINT,  -- Avances et acomptes reçus sur commandes en cours
  c_596          BIGINT,  -- Total Immobilisations – Amortissement - Plus-values, Moins-v
  c_dt          BIGINT,  -- Autres emprunts obligataires
  c_4t          BIGINT,  -- Provisions pour perte de change
  c_6a          BIGINT,  -- sur immobilisations – incorporelles
  c_140          BIGINT,  -- Provisions réglementées
  c_6e          BIGINT,  -- sur immobilisations – corporelles
  c_193          BIGINT,  -- Dont immobilisations financières à moins d’un an
  c_582          BIGINT,  -- Total Plus-values, Moins-values (Valeur résiduelle)
  c_do          BIGINT,  -- TOTAL (II)
  c_zr          BIGINT,  -- ZR
  c_my          BIGINT,  -- DIMINUTIONS Virement postes immobilisations corporelles en c
  c_256          BIGINT,  -- Dotations aux provisions
  c_209          BIGINT,  -- Ventes de marchandises – Export
  c_cb          BIGINT,  -- Capital souscrit et appelé, non versé
  c_584          BIGINT,  -- Total Plus-values, Moins-values (Prix de cession)
  c_452          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Installations générales, ag
  c_217          BIGINT,  -- Production vendue de services - Export
  c_412          BIGINT,  -- AUGMENTATIONS Immobilisations incorporelles –Autres immobili
  c_dn          BIGINT,  -- Avances conditionnées
  c_24b          BIGINT,  -- (dont crédit bail mobilier)*
  c_cw          BIGINT,  -- Charges à répartir ou frais d’émission d’emprunt
  c_24a          BIGINT,  -- (dont crédit bail immobilier)*
  c_222          BIGINT,  -- Production stockée
  c_7z          BIGINT,  -- Autres emprunts obligataires brut à un an au plus
  c_682          BIGINT,  -- AUGMENTATIONS Total Relevé des provisions
  c_088          BIGINT,  -- Caisse
  c_al          BIGINT,  -- Avances et acomptes sur immobilisations incorporelles
  c_154          BIGINT,  -- Provisions pour risques et charges - Total II
  c_z1          BIGINT,  -- Créances représentatives de titres prêtés
  c_484          BIGINT,  -- DIMINUTIONS Immobilisations financières
  c_ds          BIGINT,  -- Emprunts obligataires convertibles
  c_r1          BIGINT,  -- Compte de résultat - Intérêts et produits assimilés
  c_p2          BIGINT,  -- P2
  c_432          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Constructions
  c_4j          BIGINT,  -- Provisions pour perte sur marchés à terme
  c_130          BIGINT,  -- Réserves réglementées
  c_124          BIGINT,  -- Ecarts de réévaluation
  c_5r          BIGINT,  -- Provisions pour charges sociales et fiscales sur congés à pa
  c_p3          BIGINT,  -- P3
  c_684          BIGINT,  -- DIMINUTIONS Total Relevé des provisions
  c_p1          BIGINT,  -- P1
  c_p7          BIGINT,  -- PASSIF - Report à nouveau
  c_dm          BIGINT,  -- Produit des émissions de titres participatifs
  c_r3          BIGINT,  -- Compte de résultat - Résultat de l’exercice
  c_r5          BIGINT,  -- Résultat net des entreprises intégrées
  c_nc          BIGINT,  -- DIMINUTIONS Virement postes - Avances et acomptes
  c_224          BIGINT,  -- Production immobilisée
  c_ef          BIGINT,  -- Dont réserve réglementée des plus-values à long terme
  c_316          BIGINT,  -- Rémunération et avantages personnels non déductibles
  c_402          BIGINT,  -- AUGMENTATIONS Immobilisations incorporelles – Fonds commerci
  c_p8          BIGINT,  -- PASSIF - Résultat de l’exercice
  c_p9          BIGINT,  -- TOTAL PASSIF
  c_414          BIGINT,  -- DIMINUTIONS Immobilisations incorporelles –Autres immobilisa
  c_r2          BIGINT,  -- Compte de résultat - Intérêts et charges assimilées
  c_r6          BIGINT,  -- Résultat Groupe (Résultat net consolidé)
  c_r8          BIGINT,  -- Résultat net part du groupe (part de la société mère)
  c_624          BIGINT,  -- DIMINUTIONS Provisions pour risques et charges
  c_197          BIGINT,  -- Dont créances à plus d’un an
  c_422          BIGINT,  -- AUGMENTATIONS Imm. corporelles – Terrains
  c_7y          BIGINT,  -- Emprunts obligataires convertibles brut à un an au plus
  c_p6          BIGINT,  -- Dans les résultats
  c_p5          BIGINT,  -- PASSIF - Réserves
  c_652          BIGINT,  -- AUGMENTATIONS Provisions pour dépréciation – Sur clients et 
  c_aa          BIGINT,  -- Capital souscrit non appelé
  c_z2          BIGINT,  -- Dette représentative de titres empruntés
  c_uo          BIGINT,  -- (provision pour dépréciation antérieurement constituée)
  c_215          BIGINT,  -- Production vendue de biens - Export
  c_642          BIGINT,  -- AUGMENTATIONS Provisions pour dépréciation – Sur stocks et e
  c_r4          BIGINT,  -- R4
  c_p4          BIGINT,  -- PASSIF - Primes d’émission
  c_654          BIGINT,  -- DIMINUTIONS Provisions pour dépréciation – Sur clients et co
  c_662          BIGINT,  -- AUGMENTATIONS Provisions pour dépréciation – Autres provisio
  c_4n          BIGINT,  -- Provisions pour amendes et pénalités
  c_5b          BIGINT,  -- Provisions pour impôts
  c_602          BIGINT,  -- AUGMENTATIONS Provisions réglementées – Amortissements dérog
  c_612          BIGINT,  -- AUGMENTATIONS Provisions réglementées – Autres provisions ré
  c_622          BIGINT,  -- AUGMENTATIONS Provisions pour risques et charges
  c_02          BIGINT,  -- sur immobilisations – titres mis en équivalence
  c_vx          BIGINT,  -- Obligations cautionnées
  c_632          BIGINT,  -- AUGMENTATIONS Provisions pour dépréciation – Sur immobilisat
  c_yr          BIGINT,  -- Engagement de crédit-bail immobilier
  c_ys          BIGINT,  -- Effets portés à l’escompte et non échus
  c_644          BIGINT,  -- DIMINUTIONS Provisions pour dépréciation – Sur stocks et en 
  c_r7          BIGINT,  -- Part des intérêts minoritaires (Résultat hors groupe)
  c_ee_n1       BIGINT,
  c_co_n1       BIGINT,
  c_dl_n1       BIGINT,
  c_cj_n1       BIGINT,
  c_da_n1       BIGINT,
  c_di_n1       BIGINT,
  c_ec_n1       BIGINT,
  c_cf_n1       BIGINT,
  c_bj_n1       BIGINT,
  c_bz_n1       BIGINT,
  c_dx_n1       BIGINT,
  c_dy_n1       BIGINT,
  c_dv_n1       BIGINT,
  c_gf_n1       BIGINT,
  c_gw_n1       BIGINT,
  c_gg_n1       BIGINT,
  c_hm_n1       BIGINT,
  c_at_n1       BIGINT,
  c_hn_n1       BIGINT,
  c_fw_n1       BIGINT,
  c_bx_n1       BIGINT,
  c_dd_n1       BIGINT,
  c_hl_n1       BIGINT,
  c_ea_n1       BIGINT,
  c_vy_n1       BIGINT,
  c_fr_n1       BIGINT,
  c_ch_n1       BIGINT,
  c_vt_n1       BIGINT,
  c_eg_n1       BIGINT,
  c_du_n1       BIGINT,
  c_8b_n1       BIGINT,
  c_fj_n1       BIGINT,
  c_gv_n1       BIGINT,
  c_fx_n1       BIGINT,
  c_0g_n1       BIGINT,
  c_i4_n1       BIGINT,
  c_bh_n1       BIGINT,
  c_0n_n1       BIGINT,
  c_qu_n1       BIGINT,
  c_dg_n1       BIGINT,
  c_dh_n1       BIGINT,
  c_ar_n1       BIGINT,
  c_ge_n1       BIGINT,
  c_ga_n1       BIGINT,
  c_ln_n1       BIGINT,
  c_iy_n1       BIGINT,
  c_lq_n1       BIGINT,
  c_fq_n1       BIGINT,
  c_i3_n1       BIGINT,
  c_fg_n1       BIGINT,
  c_gu_n1       BIGINT,
  c_ux_n1       BIGINT,
  c_gp_n1       BIGINT,
  c_hk_n1       BIGINT,
  c_vs_n1       BIGINT,
  c_fz_n1       BIGINT,
  c_fy_n1       BIGINT,
  c_hi_n1       BIGINT,
  c_8d_n1       BIGINT,
  c_gr_n1       BIGINT,
  c_8k_n1       BIGINT,
  c_hh_n1       BIGINT,
  c_af_n1       BIGINT,
  c_vb_n1       BIGINT,
  c_vq_n1       BIGINT,
  c_vi_n1       BIGINT,
  c_vr_n1       BIGINT,
  c_vw_n1       BIGINT,
  c_io_n1       BIGINT,
  c_kd_n1       BIGINT,
  c_ut_n1       BIGINT,
  c_pe_n1       BIGINT,
  c_hd_n1       BIGINT,
  c_8c_n1       BIGINT,
  c_fp_n1       BIGINT,
  c_cu_n1       BIGINT,
  c_gl_n1       BIGINT,
  c_ah_n1       BIGINT,
  c_180_n1       BIGINT,
  c_he_n1       BIGINT,
  c_110_n1       BIGINT,
  c_142_n1       BIGINT,
  c_096_n1       BIGINT,
  c_120_n1       BIGINT,
  c_7c_n1       BIGINT,
  c_136_n1       BIGINT,
  c_084_n1       BIGINT,
  c_bt_n1       BIGINT,
  c_176_n1       BIGINT,
  c_vh_n1       BIGINT,
  c_ap_n1       BIGINT,
  c_vg_n1       BIGINT,
  c_vk_n1       BIGINT,
  c_172_n1       BIGINT,
  c_fu_n1       BIGINT,
  c_264_n1       BIGINT,
  c_310_n1       BIGINT,
  c_270_n1       BIGINT,
  c_fs_n1       BIGINT,
  c_242_n1       BIGINT,
  c_bl_n1       BIGINT,
  c_7b_n1       BIGINT,
  c_fa_n1       BIGINT,
  c_044_n1       BIGINT,
  c_hb_n1       BIGINT,
  c_072_n1       BIGINT,
  c_232_n1       BIGINT,
  c_cd_n1       BIGINT,
  c_ha_n1       BIGINT,
  c_bv_n1       BIGINT,
  c_bd_n1       BIGINT,
  c_6t_n1       BIGINT,
  c_166_n1       BIGINT,
  c_hf_n1       BIGINT,
  c_eh_n1       BIGINT,
  c_dw_n1       BIGINT,
  c_ue_n1       BIGINT,
  c_ft_n1       BIGINT,
  c_gc_n1       BIGINT,
  c_va_n1       BIGINT,
  c_vm_n1       BIGINT,
  c_dr_n1       BIGINT,
  c_fo_n1       BIGINT,
  c_028_n1       BIGINT,
  c_ei_n1       BIGINT,
  c_218_n1       BIGINT,
  c_134_n1       BIGINT,
  c_eb_n1       BIGINT,
  c_fv_n1       BIGINT,
  c_uy_n1       BIGINT,
  c_vc_n1       BIGINT,
  c_244_n1       BIGINT,
  c_vj_n1       BIGINT,
  c_8a_n1       BIGINT,
  c_gj_n1       BIGINT,
  c_fd_n1       BIGINT,
  c_5z_n1       BIGINT,
  c_dp_n1       BIGINT,
  c_an_n1       BIGINT,
  c_a1_n1       BIGINT,
  c_8e_n1       BIGINT,
  c_254_n1       BIGINT,
  c_yp_n1       BIGINT,
  c_040_n1       BIGINT,
  c_cp_n1       BIGINT,
  c_db_n1       BIGINT,
  c_068_n1       BIGINT,
  c_vp_n1       BIGINT,
  c_306_n1       BIGINT,
  c_126_n1       BIGINT,
  c_252_n1       BIGINT,
  c_169_n1       BIGINT,
  c_250_n1       BIGINT,
  c_aj_n1       BIGINT,
  c_8l_n1       BIGINT,
  c_230_n1       BIGINT,
  c_262_n1       BIGINT,
  c_uz_n1       BIGINT,
  c_zj_n1       BIGINT,
  c_av_n1       BIGINT,
  c_hp_n1       BIGINT,
  c_st_n1       BIGINT,
  c_fm_n1       BIGINT,
  c_294_n1       BIGINT,
  c_ss_n1       BIGINT,
  c_490_n1       BIGINT,
  c_yx_n1       BIGINT,
  c_yz_n1       BIGINT,
  c_182_n1       BIGINT,
  c_156_n1       BIGINT,
  c_9z_n1       BIGINT,
  c_yy_n1       BIGINT,
  c_bn_n1       BIGINT,
  c_xq_n1       BIGINT,
  c_yw_n1       BIGINT,
  c_dz_n1       BIGINT,
  c_378_n1       BIGINT,
  c_bb_n1       BIGINT,
  c_gd_n1       BIGINT,
  c_300_n1       BIGINT,
  c_234_n1       BIGINT,
  c_hg_n1       BIGINT,
  c_374_n1       BIGINT,
  c_yt_n1       BIGINT,
  c_6n_n1       BIGINT,
  c_092_n1       BIGINT,
  c_132_n1       BIGINT,
  c_cs_n1       BIGINT,
  c_238_n1       BIGINT,
  c_a4_n1       BIGINT,
  c_hc_n1       BIGINT,
  c_243_n1       BIGINT,
  c_280_n1       BIGINT,
  c_bf_n1       BIGINT,
  c_dq_n1       BIGINT,
  c_492_n1       BIGINT,
  c_060_n1       BIGINT,
  c_5v_n1       BIGINT,
  c_gq_n1       BIGINT,
  c_dk_n1       BIGINT,
  c_ul_n1       BIGINT,
  c_br_n1       BIGINT,
  c_4a_n1       BIGINT,
  c_gk_n1       BIGINT,
  c_uj_n1       BIGINT,
  c_014_n1       BIGINT,
  c_ax_n1       BIGINT,
  c_210_n1       BIGINT,
  c_8j_n1       BIGINT,
  c_gn_n1       BIGINT,
  c_dj_n1       BIGINT,
  c_gs_n1       BIGINT,
  c_up_n1       BIGINT,
  c_3z_n1       BIGINT,
  c_cr_n1       BIGINT,
  c_de_n1       BIGINT,
  c_hj_n1       BIGINT,
  c_a2_n1       BIGINT,
  c_195_n1       BIGINT,
  c_ug_n1       BIGINT,
  c_236_n1       BIGINT,
  c_290_n1       BIGINT,
  c_gm_n1       BIGINT,
  c_3x_n1       BIGINT,
  c_cy_n1       BIGINT,
  c_bp_n1       BIGINT,
  c_fn_n1       BIGINT,
  c_i2_n1       BIGINT,
  c_in_n1       BIGINT,
  c_yu_n1       BIGINT,
  c_cz_n1       BIGINT,
  c_go_n1       BIGINT,
  c_ab_n1       BIGINT,
  c_vn_n1       BIGINT,
  c_gb_n1       BIGINT,
  c_010_n1       BIGINT,
  c_ze_n1       BIGINT,
  c_6x_n1       BIGINT,
  c_df_n1       BIGINT,
  c_9u_n1       BIGINT,
  c_050_n1       BIGINT,
  c_080_n1       BIGINT,
  c_494_n1       BIGINT,
  c_376_n1       BIGINT,
  c_472_n1       BIGINT,
  c_482_n1       BIGINT,
  c_4x_n1       BIGINT,
  c_442_n1       BIGINT,
  c_cx_n1       BIGINT,
  c_174_n1       BIGINT,
  c_gt_n1       BIGINT,
  c_240_n1       BIGINT,
  c_462_n1       BIGINT,
  c_yq_n1       BIGINT,
  c_eo_n1       BIGINT,
  c_199_n1       BIGINT,
  c_ed_n1       BIGINT,
  c_064_n1       BIGINT,
  c_214_n1       BIGINT,
  c_gh_n1       BIGINT,
  c_226_n1       BIGINT,
  c_hq_n1       BIGINT,
  c_gi_n1       BIGINT,
  c_cn_n1       BIGINT,
  c_184_n1       BIGINT,
  c_06_n1       BIGINT,
  c_4e_n1       BIGINT,
  c_yv_n1       BIGINT,
  c_a3_n1       BIGINT,
  c_dc_n1       BIGINT,
  c_164_n1       BIGINT,
  c_596_n1       BIGINT,
  c_dt_n1       BIGINT,
  c_4t_n1       BIGINT,
  c_6a_n1       BIGINT,
  c_140_n1       BIGINT,
  c_6e_n1       BIGINT,
  c_193_n1       BIGINT,
  c_582_n1       BIGINT,
  c_do_n1       BIGINT,
  c_zr_n1       BIGINT,
  c_my_n1       BIGINT,
  c_256_n1       BIGINT,
  c_209_n1       BIGINT,
  c_cb_n1       BIGINT,
  c_584_n1       BIGINT,
  c_452_n1       BIGINT,
  c_217_n1       BIGINT,
  c_412_n1       BIGINT,
  c_dn_n1       BIGINT,
  c_24b_n1       BIGINT,
  c_cw_n1       BIGINT,
  c_24a_n1       BIGINT,
  c_222_n1       BIGINT,
  c_7z_n1       BIGINT,
  c_682_n1       BIGINT,
  c_088_n1       BIGINT,
  c_al_n1       BIGINT,
  c_154_n1       BIGINT,
  c_z1_n1       BIGINT,
  c_484_n1       BIGINT,
  c_ds_n1       BIGINT,
  c_r1_n1       BIGINT,
  c_p2_n1       BIGINT,
  c_432_n1       BIGINT,
  c_4j_n1       BIGINT,
  c_130_n1       BIGINT,
  c_124_n1       BIGINT,
  c_5r_n1       BIGINT,
  c_p3_n1       BIGINT,
  c_684_n1       BIGINT,
  c_p1_n1       BIGINT,
  c_p7_n1       BIGINT,
  c_dm_n1       BIGINT,
  c_r3_n1       BIGINT,
  c_r5_n1       BIGINT,
  c_nc_n1       BIGINT,
  c_224_n1       BIGINT,
  c_ef_n1       BIGINT,
  c_316_n1       BIGINT,
  c_402_n1       BIGINT,
  c_p8_n1       BIGINT,
  c_p9_n1       BIGINT,
  c_414_n1       BIGINT,
  c_r2_n1       BIGINT,
  c_r6_n1       BIGINT,
  c_r8_n1       BIGINT,
  c_624_n1       BIGINT,
  c_197_n1       BIGINT,
  c_422_n1       BIGINT,
  c_7y_n1       BIGINT,
  c_p6_n1       BIGINT,
  c_p5_n1       BIGINT,
  c_652_n1       BIGINT,
  c_aa_n1       BIGINT,
  c_z2_n1       BIGINT,
  c_uo_n1       BIGINT,
  c_215_n1       BIGINT,
  c_642_n1       BIGINT,
  c_r4_n1       BIGINT,
  c_p4_n1       BIGINT,
  c_654_n1       BIGINT,
  c_662_n1       BIGINT,
  c_4n_n1       BIGINT,
  c_5b_n1       BIGINT,
  c_602_n1       BIGINT,
  c_612_n1       BIGINT,
  c_622_n1       BIGINT,
  c_02_n1       BIGINT,
  c_vx_n1       BIGINT,
  c_632_n1       BIGINT,
  c_yr_n1       BIGINT,
  c_ys_n1       BIGINT,
  c_644_n1       BIGINT,
  c_r7_n1       BIGINT,
  c_ee_yoy_pct REAL,
  c_co_yoy_pct REAL,
  c_dl_yoy_pct REAL,
  c_cj_yoy_pct REAL,
  c_da_yoy_pct REAL,
  c_di_yoy_pct REAL,
  c_ec_yoy_pct REAL,
  c_cf_yoy_pct REAL,
  c_bj_yoy_pct REAL,
  c_bz_yoy_pct REAL,
  c_dx_yoy_pct REAL,
  c_dy_yoy_pct REAL,
  c_dv_yoy_pct REAL,
  c_gf_yoy_pct REAL,
  c_gw_yoy_pct REAL,
  c_gg_yoy_pct REAL,
  c_hm_yoy_pct REAL,
  c_at_yoy_pct REAL,
  c_hn_yoy_pct REAL,
  c_fw_yoy_pct REAL,
  c_bx_yoy_pct REAL,
  c_dd_yoy_pct REAL,
  c_hl_yoy_pct REAL,
  c_ea_yoy_pct REAL,
  c_vy_yoy_pct REAL,
  c_fr_yoy_pct REAL,
  c_ch_yoy_pct REAL,
  c_vt_yoy_pct REAL,
  c_eg_yoy_pct REAL,
  c_du_yoy_pct REAL,
  c_8b_yoy_pct REAL,
  c_fj_yoy_pct REAL,
  c_gv_yoy_pct REAL,
  c_fx_yoy_pct REAL,
  c_0g_yoy_pct REAL,
  c_i4_yoy_pct REAL,
  c_bh_yoy_pct REAL,
  c_0n_yoy_pct REAL,
  c_qu_yoy_pct REAL,
  c_dg_yoy_pct REAL,
  c_dh_yoy_pct REAL,
  c_ar_yoy_pct REAL,
  c_ge_yoy_pct REAL,
  c_ga_yoy_pct REAL,
  c_ln_yoy_pct REAL,
  c_iy_yoy_pct REAL,
  c_lq_yoy_pct REAL,
  c_fq_yoy_pct REAL,
  c_i3_yoy_pct REAL,
  c_fg_yoy_pct REAL,
  c_gu_yoy_pct REAL,
  c_ux_yoy_pct REAL,
  c_gp_yoy_pct REAL,
  c_hk_yoy_pct REAL,
  c_vs_yoy_pct REAL,
  c_fz_yoy_pct REAL,
  c_fy_yoy_pct REAL,
  c_hi_yoy_pct REAL,
  c_8d_yoy_pct REAL,
  c_gr_yoy_pct REAL,
  c_8k_yoy_pct REAL,
  c_hh_yoy_pct REAL,
  c_af_yoy_pct REAL,
  c_vb_yoy_pct REAL,
  c_vq_yoy_pct REAL,
  c_vi_yoy_pct REAL,
  c_vr_yoy_pct REAL,
  c_vw_yoy_pct REAL,
  c_io_yoy_pct REAL,
  c_kd_yoy_pct REAL,
  c_ut_yoy_pct REAL,
  c_pe_yoy_pct REAL,
  c_hd_yoy_pct REAL,
  c_8c_yoy_pct REAL,
  c_fp_yoy_pct REAL,
  c_cu_yoy_pct REAL,
  c_gl_yoy_pct REAL,
  c_ah_yoy_pct REAL,
  c_180_yoy_pct REAL,
  c_he_yoy_pct REAL,
  c_110_yoy_pct REAL,
  c_142_yoy_pct REAL,
  c_096_yoy_pct REAL,
  c_120_yoy_pct REAL,
  c_7c_yoy_pct REAL,
  c_136_yoy_pct REAL,
  c_084_yoy_pct REAL,
  c_bt_yoy_pct REAL,
  c_176_yoy_pct REAL,
  c_vh_yoy_pct REAL,
  c_ap_yoy_pct REAL,
  c_vg_yoy_pct REAL,
  c_vk_yoy_pct REAL,
  c_172_yoy_pct REAL,
  c_fu_yoy_pct REAL,
  c_264_yoy_pct REAL,
  c_310_yoy_pct REAL,
  c_270_yoy_pct REAL,
  c_fs_yoy_pct REAL,
  c_242_yoy_pct REAL,
  c_bl_yoy_pct REAL,
  c_7b_yoy_pct REAL,
  c_fa_yoy_pct REAL,
  c_044_yoy_pct REAL,
  c_hb_yoy_pct REAL,
  c_072_yoy_pct REAL,
  c_232_yoy_pct REAL,
  c_cd_yoy_pct REAL,
  c_ha_yoy_pct REAL,
  c_bv_yoy_pct REAL,
  c_bd_yoy_pct REAL,
  c_6t_yoy_pct REAL,
  c_166_yoy_pct REAL,
  c_hf_yoy_pct REAL,
  c_eh_yoy_pct REAL,
  c_dw_yoy_pct REAL,
  c_ue_yoy_pct REAL,
  c_ft_yoy_pct REAL,
  c_gc_yoy_pct REAL,
  c_va_yoy_pct REAL,
  c_vm_yoy_pct REAL,
  c_dr_yoy_pct REAL,
  c_fo_yoy_pct REAL,
  c_028_yoy_pct REAL,
  c_ei_yoy_pct REAL,
  c_218_yoy_pct REAL,
  c_134_yoy_pct REAL,
  c_eb_yoy_pct REAL,
  c_fv_yoy_pct REAL,
  c_uy_yoy_pct REAL,
  c_vc_yoy_pct REAL,
  c_244_yoy_pct REAL,
  c_vj_yoy_pct REAL,
  c_8a_yoy_pct REAL,
  c_gj_yoy_pct REAL,
  c_fd_yoy_pct REAL,
  c_5z_yoy_pct REAL,
  c_dp_yoy_pct REAL,
  c_an_yoy_pct REAL,
  c_a1_yoy_pct REAL,
  c_8e_yoy_pct REAL,
  c_254_yoy_pct REAL,
  c_yp_yoy_pct REAL,
  c_040_yoy_pct REAL,
  c_cp_yoy_pct REAL,
  c_db_yoy_pct REAL,
  c_068_yoy_pct REAL,
  c_vp_yoy_pct REAL,
  c_306_yoy_pct REAL,
  c_126_yoy_pct REAL,
  c_252_yoy_pct REAL,
  c_169_yoy_pct REAL,
  c_250_yoy_pct REAL,
  c_aj_yoy_pct REAL,
  c_8l_yoy_pct REAL,
  c_230_yoy_pct REAL,
  c_262_yoy_pct REAL,
  c_uz_yoy_pct REAL,
  c_zj_yoy_pct REAL,
  c_av_yoy_pct REAL,
  c_hp_yoy_pct REAL,
  c_st_yoy_pct REAL,
  c_fm_yoy_pct REAL,
  c_294_yoy_pct REAL,
  c_ss_yoy_pct REAL,
  c_490_yoy_pct REAL,
  c_yx_yoy_pct REAL,
  c_yz_yoy_pct REAL,
  c_182_yoy_pct REAL,
  c_156_yoy_pct REAL,
  c_9z_yoy_pct REAL,
  c_yy_yoy_pct REAL,
  c_bn_yoy_pct REAL,
  c_xq_yoy_pct REAL,
  c_yw_yoy_pct REAL,
  c_dz_yoy_pct REAL,
  c_378_yoy_pct REAL,
  c_bb_yoy_pct REAL,
  c_gd_yoy_pct REAL,
  c_300_yoy_pct REAL,
  c_234_yoy_pct REAL,
  c_hg_yoy_pct REAL,
  c_374_yoy_pct REAL,
  c_yt_yoy_pct REAL,
  c_6n_yoy_pct REAL,
  c_092_yoy_pct REAL,
  c_132_yoy_pct REAL,
  c_cs_yoy_pct REAL,
  c_238_yoy_pct REAL,
  c_a4_yoy_pct REAL,
  c_hc_yoy_pct REAL,
  c_243_yoy_pct REAL,
  c_280_yoy_pct REAL,
  c_bf_yoy_pct REAL,
  c_dq_yoy_pct REAL,
  c_492_yoy_pct REAL,
  c_060_yoy_pct REAL,
  c_5v_yoy_pct REAL,
  c_gq_yoy_pct REAL,
  c_dk_yoy_pct REAL,
  c_ul_yoy_pct REAL,
  c_br_yoy_pct REAL,
  c_4a_yoy_pct REAL,
  c_gk_yoy_pct REAL,
  c_uj_yoy_pct REAL,
  c_014_yoy_pct REAL,
  c_ax_yoy_pct REAL,
  c_210_yoy_pct REAL,
  c_8j_yoy_pct REAL,
  c_gn_yoy_pct REAL,
  c_dj_yoy_pct REAL,
  c_gs_yoy_pct REAL,
  c_up_yoy_pct REAL,
  c_3z_yoy_pct REAL,
  c_cr_yoy_pct REAL,
  c_de_yoy_pct REAL,
  c_hj_yoy_pct REAL,
  c_a2_yoy_pct REAL,
  c_195_yoy_pct REAL,
  c_ug_yoy_pct REAL,
  c_236_yoy_pct REAL,
  c_290_yoy_pct REAL,
  c_gm_yoy_pct REAL,
  c_3x_yoy_pct REAL,
  c_cy_yoy_pct REAL,
  c_bp_yoy_pct REAL,
  c_fn_yoy_pct REAL,
  c_i2_yoy_pct REAL,
  c_in_yoy_pct REAL,
  c_yu_yoy_pct REAL,
  c_cz_yoy_pct REAL,
  c_go_yoy_pct REAL,
  c_ab_yoy_pct REAL,
  c_vn_yoy_pct REAL,
  c_gb_yoy_pct REAL,
  c_010_yoy_pct REAL,
  c_ze_yoy_pct REAL,
  c_6x_yoy_pct REAL,
  c_df_yoy_pct REAL,
  c_9u_yoy_pct REAL,
  c_050_yoy_pct REAL,
  c_080_yoy_pct REAL,
  c_494_yoy_pct REAL,
  c_376_yoy_pct REAL,
  c_472_yoy_pct REAL,
  c_482_yoy_pct REAL,
  c_4x_yoy_pct REAL,
  c_442_yoy_pct REAL,
  c_cx_yoy_pct REAL,
  c_174_yoy_pct REAL,
  c_gt_yoy_pct REAL,
  c_240_yoy_pct REAL,
  c_462_yoy_pct REAL,
  c_yq_yoy_pct REAL,
  c_eo_yoy_pct REAL,
  c_199_yoy_pct REAL,
  c_ed_yoy_pct REAL,
  c_064_yoy_pct REAL,
  c_214_yoy_pct REAL,
  c_gh_yoy_pct REAL,
  c_226_yoy_pct REAL,
  c_hq_yoy_pct REAL,
  c_gi_yoy_pct REAL,
  c_cn_yoy_pct REAL,
  c_184_yoy_pct REAL,
  c_06_yoy_pct REAL,
  c_4e_yoy_pct REAL,
  c_yv_yoy_pct REAL,
  c_a3_yoy_pct REAL,
  c_dc_yoy_pct REAL,
  c_164_yoy_pct REAL,
  c_596_yoy_pct REAL,
  c_dt_yoy_pct REAL,
  c_4t_yoy_pct REAL,
  c_6a_yoy_pct REAL,
  c_140_yoy_pct REAL,
  c_6e_yoy_pct REAL,
  c_193_yoy_pct REAL,
  c_582_yoy_pct REAL,
  c_do_yoy_pct REAL,
  c_zr_yoy_pct REAL,
  c_my_yoy_pct REAL,
  c_256_yoy_pct REAL,
  c_209_yoy_pct REAL,
  c_cb_yoy_pct REAL,
  c_584_yoy_pct REAL,
  c_452_yoy_pct REAL,
  c_217_yoy_pct REAL,
  c_412_yoy_pct REAL,
  c_dn_yoy_pct REAL,
  c_24b_yoy_pct REAL,
  c_cw_yoy_pct REAL,
  c_24a_yoy_pct REAL,
  c_222_yoy_pct REAL,
  c_7z_yoy_pct REAL,
  c_682_yoy_pct REAL,
  c_088_yoy_pct REAL,
  c_al_yoy_pct REAL,
  c_154_yoy_pct REAL,
  c_z1_yoy_pct REAL,
  c_484_yoy_pct REAL,
  c_ds_yoy_pct REAL,
  c_r1_yoy_pct REAL,
  c_p2_yoy_pct REAL,
  c_432_yoy_pct REAL,
  c_4j_yoy_pct REAL,
  c_130_yoy_pct REAL,
  c_124_yoy_pct REAL,
  c_5r_yoy_pct REAL,
  c_p3_yoy_pct REAL,
  c_684_yoy_pct REAL,
  c_p1_yoy_pct REAL,
  c_p7_yoy_pct REAL,
  c_dm_yoy_pct REAL,
  c_r3_yoy_pct REAL,
  c_r5_yoy_pct REAL,
  c_nc_yoy_pct REAL,
  c_224_yoy_pct REAL,
  c_ef_yoy_pct REAL,
  c_316_yoy_pct REAL,
  c_402_yoy_pct REAL,
  c_p8_yoy_pct REAL,
  c_p9_yoy_pct REAL,
  c_414_yoy_pct REAL,
  c_r2_yoy_pct REAL,
  c_r6_yoy_pct REAL,
  c_r8_yoy_pct REAL,
  c_624_yoy_pct REAL,
  c_197_yoy_pct REAL,
  c_422_yoy_pct REAL,
  c_7y_yoy_pct REAL,
  c_p6_yoy_pct REAL,
  c_p5_yoy_pct REAL,
  c_652_yoy_pct REAL,
  c_aa_yoy_pct REAL,
  c_z2_yoy_pct REAL,
  c_uo_yoy_pct REAL,
  c_215_yoy_pct REAL,
  c_642_yoy_pct REAL,
  c_r4_yoy_pct REAL,
  c_p4_yoy_pct REAL,
  c_654_yoy_pct REAL,
  c_662_yoy_pct REAL,
  c_4n_yoy_pct REAL,
  c_5b_yoy_pct REAL,
  c_602_yoy_pct REAL,
  c_612_yoy_pct REAL,
  c_622_yoy_pct REAL,
  c_02_yoy_pct REAL,
  c_vx_yoy_pct REAL,
  c_632_yoy_pct REAL,
  c_yr_yoy_pct REAL,
  c_ys_yoy_pct REAL,
  c_644_yoy_pct REAL,
  c_r7_yoy_pct REAL,

  -- ── Long-tail JSONB drill-down ─────────────────────────
  -- All cerfa lines (including codes not yet promoted to columns) for
  -- ad-hoc queries; GIN-indexed below.
  liasse_postes JSONB,

  -- ── Provenance ─────────────────────────────────────────
  fs_id           UUID NOT NULL,
  rne_updated_at  TIMESTAMPTZ,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (siren, exercise_year)
);

COMMENT ON COLUMN company_financials_screener.c_EE IS 'TOTAL GENERAL (I à V) (cerfa code EE)';
COMMENT ON COLUMN company_financials_screener.c_CO IS 'TOTAL GENERAL (0 à V) (cerfa code CO)';
COMMENT ON COLUMN company_financials_screener.c_DL IS 'TOTAL (I) (cerfa code DL)';
COMMENT ON COLUMN company_financials_screener.c_CJ IS 'TOTAL (II) (cerfa code CJ)';
COMMENT ON COLUMN company_financials_screener.c_DA IS 'Capital social ou individuel (cerfa code DA)';
COMMENT ON COLUMN company_financials_screener.c_DI IS 'RESULTAT DE L’EXERCICE (bénéfice ou perte) (cerfa code DI)';
COMMENT ON COLUMN company_financials_screener.c_EC IS 'TOTAL (IV) (cerfa code EC)';
COMMENT ON COLUMN company_financials_screener.c_CF IS 'Disponibilités (cerfa code CF)';
COMMENT ON COLUMN company_financials_screener.c_BJ IS 'TOTAL (I) (cerfa code BJ)';
COMMENT ON COLUMN company_financials_screener.c_BZ IS 'Autres créances (cerfa code BZ)';
COMMENT ON COLUMN company_financials_screener.c_DX IS 'Dettes fournisseurs et comptes rattachés (cerfa code DX)';
COMMENT ON COLUMN company_financials_screener.c_DY IS 'Dettes fiscales et sociales (cerfa code DY)';
COMMENT ON COLUMN company_financials_screener.c_DV IS 'Emprunts et dettes financières divers (4) (cerfa code DV)';
COMMENT ON COLUMN company_financials_screener.c_GF IS 'Total des charges d’exploitation (II) (cerfa code GF)';
COMMENT ON COLUMN company_financials_screener.c_GW IS 'RESULTAT COURANT AVANT IMPOTS (I - II + III - IV + V - VI) (cerfa code GW)';
COMMENT ON COLUMN company_financials_screener.c_GG IS 'RESULTAT D’EXPLOITATION (I - II) (cerfa code GG)';
COMMENT ON COLUMN company_financials_screener.c_HM IS 'TOTAL DES CHARGES (II + IV + VI + VIII + IX + X) (cerfa code HM)';
COMMENT ON COLUMN company_financials_screener.c_AT IS 'Autres immobilisations corporelles (cerfa code AT)';
COMMENT ON COLUMN company_financials_screener.c_HN IS 'BENEFICE OU PERTE (Total des produits - Total des charges) (cerfa code HN)';
COMMENT ON COLUMN company_financials_screener.c_FW IS 'Autres achats et charges externes (cerfa code FW)';
COMMENT ON COLUMN company_financials_screener.c_BX IS 'Clients et comptes rattachés (cerfa code BX)';
COMMENT ON COLUMN company_financials_screener.c_DD IS 'Réserve légale (1) (cerfa code DD)';
COMMENT ON COLUMN company_financials_screener.c_HL IS 'TOTAL DES PRODUITS (I + III + V + VII) (cerfa code HL)';
COMMENT ON COLUMN company_financials_screener.c_EA IS 'Autres dettes (cerfa code EA)';
COMMENT ON COLUMN company_financials_screener.c_VY IS 'TOTAL – ETAT DES DETTES (cerfa code VY)';
COMMENT ON COLUMN company_financials_screener.c_FR IS 'Total des produits d’exploitation (I) (cerfa code FR)';
COMMENT ON COLUMN company_financials_screener.c_CH IS 'Charges constatées d’avance (cerfa code CH)';
COMMENT ON COLUMN company_financials_screener.c_VT IS 'TOTAL – ETAT DES CREANCES (cerfa code VT)';
COMMENT ON COLUMN company_financials_screener.c_EG IS 'Dettes et produits constatés d’avance à moins d’un an (cerfa code EG)';
COMMENT ON COLUMN company_financials_screener.c_DU IS 'Emprunts et dettes auprès des établissements de crédit (3) (cerfa code DU)';
COMMENT ON COLUMN company_financials_screener.c_8B IS 'Fournisseurs et comptes rattachés (cerfa code 8B)';
COMMENT ON COLUMN company_financials_screener.c_FJ IS 'Chiffres d’affaires nets (cerfa code FJ)';
COMMENT ON COLUMN company_financials_screener.c_GV IS 'RESULTAT FINANCIER (V - VI) (cerfa code GV)';
COMMENT ON COLUMN company_financials_screener.c_FX IS 'Impôts, taxes et versements assimilés (cerfa code FX)';
COMMENT ON COLUMN company_financials_screener.c_0G IS 'ACQUISITIONS Total Général (cerfa code 0G)';
COMMENT ON COLUMN company_financials_screener.c_I4 IS 'DIMINUTIONS Total Général (cerfa code I4)';
COMMENT ON COLUMN company_financials_screener.c_BH IS 'Autres immobilisations financières (cerfa code BH)';
COMMENT ON COLUMN company_financials_screener.c_0N IS 'AMORTISSEMENTS Total Général (cerfa code 0N)';
COMMENT ON COLUMN company_financials_screener.c_QU IS 'AMORTISSEMENTS Total Immobilisations corporelles (cerfa code QU)';
COMMENT ON COLUMN company_financials_screener.c_DG IS 'Autres réserves (cerfa code DG)';
COMMENT ON COLUMN company_financials_screener.c_DH IS 'Report à nouveau (cerfa code DH)';
COMMENT ON COLUMN company_financials_screener.c_AR IS 'Installations techniques, matériel et outillage industriels (cerfa code AR)';
COMMENT ON COLUMN company_financials_screener.c_GE IS 'Autres charges (cerfa code GE)';
COMMENT ON COLUMN company_financials_screener.c_GA IS 'Dot. d’exploit. - Dotations aux amortissements (cerfa code GA)';
COMMENT ON COLUMN company_financials_screener.c_LN IS 'ACQUISITIONS Total Immobilisations corporelles (cerfa code LN)';
COMMENT ON COLUMN company_financials_screener.c_IY IS 'DIMINUTIONS Total Immobilisations corporelles (cerfa code IY)';
COMMENT ON COLUMN company_financials_screener.c_LQ IS 'ACQUISITIONS Total Immobilisations financières (cerfa code LQ)';
COMMENT ON COLUMN company_financials_screener.c_FQ IS 'Autres produits (cerfa code FQ)';
COMMENT ON COLUMN company_financials_screener.c_I3 IS 'DIMINUTIONS Total Immobilisations financières (cerfa code I3)';
COMMENT ON COLUMN company_financials_screener.c_FG IS 'Production vendue services (cerfa code FG)';
COMMENT ON COLUMN company_financials_screener.c_GU IS 'Total des charges financières (VI) (cerfa code GU)';
COMMENT ON COLUMN company_financials_screener.c_UX IS 'Autres créances clients (cerfa code UX)';
COMMENT ON COLUMN company_financials_screener.c_GP IS 'Total des produits financiers (V) (cerfa code GP)';
COMMENT ON COLUMN company_financials_screener.c_HK IS 'Impôts sur les bénéfices (X) (cerfa code HK)';
COMMENT ON COLUMN company_financials_screener.c_VS IS 'Charges constatées d’avance (cerfa code VS)';
COMMENT ON COLUMN company_financials_screener.c_FZ IS 'Charges sociales (cerfa code FZ)';
COMMENT ON COLUMN company_financials_screener.c_FY IS 'Salaires et traitements (cerfa code FY)';
COMMENT ON COLUMN company_financials_screener.c_HI IS 'RESULTAT EXCEPTIONNEL (VII - VIII) (cerfa code HI)';
COMMENT ON COLUMN company_financials_screener.c_8D IS 'Sécurité sociale et autres organismes sociaux (cerfa code 8D)';
COMMENT ON COLUMN company_financials_screener.c_GR IS 'Intérêts et charges assimilées (cerfa code GR)';
COMMENT ON COLUMN company_financials_screener.c_8K IS 'Autres dettes (dont dettes relatives à des opérations de pension de titre) (cerfa code 8K)';
COMMENT ON COLUMN company_financials_screener.c_HH IS 'Total des charges exceptionnelles (VIII) (cerfa code HH)';
COMMENT ON COLUMN company_financials_screener.c_AF IS 'Concessions, brevets et droits similaires (cerfa code AF)';
COMMENT ON COLUMN company_financials_screener.c_VB IS 'T. V. A. (cerfa code VB)';
COMMENT ON COLUMN company_financials_screener.c_VQ IS 'Autres impôts, taxes et assimilés (cerfa code VQ)';
COMMENT ON COLUMN company_financials_screener.c_VI IS 'Groupe et associés (cerfa code VI)';
COMMENT ON COLUMN company_financials_screener.c_VR IS 'Débiteurs divers (dont créances relatives à des opérations de pension de titres) (cerfa code VR)';
COMMENT ON COLUMN company_financials_screener.c_VW IS 'T.V.A. (cerfa code VW)';
COMMENT ON COLUMN company_financials_screener.c_IO IS 'DIMINUTIONS Total dont autres postes d’immobilisations incorporelles (cerfa code IO)';
COMMENT ON COLUMN company_financials_screener.c_KD IS 'ACQUISITIONS Total dont autres postes d’immobilisations incorporelles (cerfa code KD)';
COMMENT ON COLUMN company_financials_screener.c_UT IS 'Autres immobilisations financières (cerfa code UT)';
COMMENT ON COLUMN company_financials_screener.c_PE IS 'AMORTISSEMENTS Total dont autres immobilisations incorporelles (cerfa code PE)';
COMMENT ON COLUMN company_financials_screener.c_HD IS 'Total des produits exceptionnels (VII) (cerfa code HD)';
COMMENT ON COLUMN company_financials_screener.c_8C IS 'Personnel et comptes rattachés (cerfa code 8C)';
COMMENT ON COLUMN company_financials_screener.c_FP IS 'Reprises sur amortissements et provisions, transfert de charges (cerfa code FP)';
COMMENT ON COLUMN company_financials_screener.c_CU IS 'Autres participations (cerfa code CU)';
COMMENT ON COLUMN company_financials_screener.c_GL IS 'Autres intérêts et produits assimilés (cerfa code GL)';
COMMENT ON COLUMN company_financials_screener.c_AH IS 'Fonds commercial (cerfa code AH)';
COMMENT ON COLUMN company_financials_screener.c_180 IS 'Total général Passif (cerfa code 180)';
COMMENT ON COLUMN company_financials_screener.c_HE IS 'Charges exceptionnelles sur opérations de gestion (cerfa code HE)';
COMMENT ON COLUMN company_financials_screener.c_110 IS 'Total général Actif (cerfa code 110)';
COMMENT ON COLUMN company_financials_screener.c_142 IS 'Total des capitaux propres - Total I (cerfa code 142)';
COMMENT ON COLUMN company_financials_screener.c_096 IS 'Total Actif circulant + Charges constatées d’avance (cerfa code 096)';
COMMENT ON COLUMN company_financials_screener.c_120 IS 'Capital social ou individuel (cerfa code 120)';
COMMENT ON COLUMN company_financials_screener.c_7C IS 'TOTAL GENERAL (cerfa code 7C)';
COMMENT ON COLUMN company_financials_screener.c_136 IS 'Résultat de l’exercice (cerfa code 136)';
COMMENT ON COLUMN company_financials_screener.c_084 IS 'Disponibilités (cerfa code 084)';
COMMENT ON COLUMN company_financials_screener.c_BT IS 'Marchandises (cerfa code BT)';
COMMENT ON COLUMN company_financials_screener.c_176 IS 'Total des dettes (cerfa code 176)';
COMMENT ON COLUMN company_financials_screener.c_VH IS 'Emprunts à plus d’1 an à l’origine (cerfa code VH)';
COMMENT ON COLUMN company_financials_screener.c_AP IS 'Constructions (cerfa code AP)';
COMMENT ON COLUMN company_financials_screener.c_VG IS 'Emprunts à 1 an maximum à l’origine (cerfa code VG)';
COMMENT ON COLUMN company_financials_screener.c_VK IS 'Emprunts remboursés en cours d’exercice (cerfa code VK)';
COMMENT ON COLUMN company_financials_screener.c_172 IS 'Autres dettes (cerfa code 172)';
COMMENT ON COLUMN company_financials_screener.c_FU IS 'Achats de matières premières et autres approvisionnements (cerfa code FU)';
COMMENT ON COLUMN company_financials_screener.c_264 IS 'Total des charges d’exploitation (cerfa code 264)';
COMMENT ON COLUMN company_financials_screener.c_310 IS 'Bénéfice ou perte (cerfa code 310)';
COMMENT ON COLUMN company_financials_screener.c_270 IS 'Résultat d’exploitation (cerfa code 270)';
COMMENT ON COLUMN company_financials_screener.c_FS IS 'Achats de marchandises (y compris droits de douane) (cerfa code FS)';
COMMENT ON COLUMN company_financials_screener.c_242 IS 'Autres charges externes* (cerfa code 242)';
COMMENT ON COLUMN company_financials_screener.c_BL IS 'Matières premières, approvisionnements (cerfa code BL)';
COMMENT ON COLUMN company_financials_screener.c_7B IS 'Total Provisions pour dépréciation (cerfa code 7B)';
COMMENT ON COLUMN company_financials_screener.c_FA IS 'Ventes de marchandises (cerfa code FA)';
COMMENT ON COLUMN company_financials_screener.c_044 IS 'Total Actif Immobilisé (cerfa code 044)';
COMMENT ON COLUMN company_financials_screener.c_HB IS 'Produits exceptionnels sur opérations en capital (cerfa code HB)';
COMMENT ON COLUMN company_financials_screener.c_072 IS 'Créances – Autres (cerfa code 072)';
COMMENT ON COLUMN company_financials_screener.c_232 IS 'Total des produits d’exploitation hors T.V.A. (cerfa code 232)';
COMMENT ON COLUMN company_financials_screener.c_CD IS 'Valeurs mobilières de placement (cerfa code CD)';
COMMENT ON COLUMN company_financials_screener.c_HA IS 'Produits exceptionnels sur opérations de gestion (cerfa code HA)';
COMMENT ON COLUMN company_financials_screener.c_BV IS 'Avances et acomptes versés sur commandes (cerfa code BV)';
COMMENT ON COLUMN company_financials_screener.c_BD IS 'Autres titres immobilisés (cerfa code BD)';
COMMENT ON COLUMN company_financials_screener.c_6T IS 'Sur comptes clients (cerfa code 6T)';
COMMENT ON COLUMN company_financials_screener.c_166 IS 'Fournisseurs et comptes rattachés (cerfa code 166)';
COMMENT ON COLUMN company_financials_screener.c_HF IS 'Charges exceptionnelles sur opérations en capital (cerfa code HF)';
COMMENT ON COLUMN company_financials_screener.c_EH IS 'Dont concours bancaires courants, et soldes créditeurs de banques et C.C.P. (cerfa code EH)';
COMMENT ON COLUMN company_financials_screener.c_DW IS 'Avances et acomptes reçus sur commandes en cours (cerfa code DW)';
COMMENT ON COLUMN company_financials_screener.c_UE IS 'dont dotations et reprises : - d’Exploitation (cerfa code UE)';
COMMENT ON COLUMN company_financials_screener.c_FT IS 'Variation de stock (marchandises) (cerfa code FT)';
COMMENT ON COLUMN company_financials_screener.c_GC IS 'Dot. d’exploit. Sur actif circulant : dotations aux provisions (cerfa code GC)';
COMMENT ON COLUMN company_financials_screener.c_VA IS 'Clients douteux ou litigieux (cerfa code VA)';
COMMENT ON COLUMN company_financials_screener.c_VM IS 'Impôts sur les bénéfices (cerfa code VM)';
COMMENT ON COLUMN company_financials_screener.c_DR IS 'TOTAL (III) (cerfa code DR)';
COMMENT ON COLUMN company_financials_screener.c_FO IS 'Subventions d’exploitation (cerfa code FO)';
COMMENT ON COLUMN company_financials_screener.c_028 IS 'Immobilisations corporelles (cerfa code 028)';
COMMENT ON COLUMN company_financials_screener.c_EI IS 'Dont emprunts participatifs (cerfa code EI)';
COMMENT ON COLUMN company_financials_screener.c_218 IS 'Production vendue de services - France (cerfa code 218)';
COMMENT ON COLUMN company_financials_screener.c_134 IS 'Report à nouveau (cerfa code 134)';
COMMENT ON COLUMN company_financials_screener.c_EB IS 'Produits constatés d’avance (2) (cerfa code EB)';
COMMENT ON COLUMN company_financials_screener.c_FV IS 'Variation de stock (matières premières et approvisionnements) (cerfa code FV)';
COMMENT ON COLUMN company_financials_screener.c_UY IS 'Personnel et comptes rattachés (cerfa code UY)';
COMMENT ON COLUMN company_financials_screener.c_VC IS 'Groupe et associés (cerfa code VC)';
COMMENT ON COLUMN company_financials_screener.c_244 IS 'Impôts, taxes et versements assimilés (cerfa code 244)';
COMMENT ON COLUMN company_financials_screener.c_VJ IS 'Emprunts souscrits en cours d’exercice (cerfa code VJ)';
COMMENT ON COLUMN company_financials_screener.c_8A IS 'Emprunts et dettes financières divers (cerfa code 8A)';
COMMENT ON COLUMN company_financials_screener.c_GJ IS 'Produits financiers de participations (cerfa code GJ)';
COMMENT ON COLUMN company_financials_screener.c_FD IS 'Production vendue biens (cerfa code FD)';
COMMENT ON COLUMN company_financials_screener.c_5Z IS 'Total Provisions pour risques et charges (cerfa code 5Z)';
COMMENT ON COLUMN company_financials_screener.c_DP IS 'Provisions pour risques (cerfa code DP)';
COMMENT ON COLUMN company_financials_screener.c_AN IS 'Terrains (cerfa code AN)';
COMMENT ON COLUMN company_financials_screener.c_A1 IS 'ACTIF - Créances sur les Ets de crédit (cerfa code A1)';
COMMENT ON COLUMN company_financials_screener.c_8E IS 'Impôts sur les bénéfices (cerfa code 8E)';
COMMENT ON COLUMN company_financials_screener.c_254 IS 'Dotations aux amortissements (cerfa code 254)';
COMMENT ON COLUMN company_financials_screener.c_YP IS 'Effectif moyen du personnel (cerfa code YP)';
COMMENT ON COLUMN company_financials_screener.c_040 IS 'Immobilisations financières (cerfa code 040)';
COMMENT ON COLUMN company_financials_screener.c_CP IS 'Parts à moins d’un an (cerfa code CP)';
COMMENT ON COLUMN company_financials_screener.c_DB IS 'Primes d’émission, de fusion, d’apport, … (cerfa code DB)';
COMMENT ON COLUMN company_financials_screener.c_068 IS 'Créances – Clients et comptes rattachés (cerfa code 068)';
COMMENT ON COLUMN company_financials_screener.c_VP IS 'Divers (cerfa code VP)';
COMMENT ON COLUMN company_financials_screener.c_306 IS 'Impôts sur les bénéfices (cerfa code 306)';
COMMENT ON COLUMN company_financials_screener.c_126 IS 'Réserve légale (cerfa code 126)';
COMMENT ON COLUMN company_financials_screener.c_252 IS 'Charges sociales (cerfa code 252)';
COMMENT ON COLUMN company_financials_screener.c_169 IS 'Autres dettes dont comptes courant d’associés de l’exercice N (cerfa code 169)';
COMMENT ON COLUMN company_financials_screener.c_250 IS 'Rémunérations du personnel (cerfa code 250)';
COMMENT ON COLUMN company_financials_screener.c_AJ IS 'Autres immobilisations incorporelles (cerfa code AJ)';
COMMENT ON COLUMN company_financials_screener.c_8L IS 'Produits constatés d’avance (cerfa code 8L)';
COMMENT ON COLUMN company_financials_screener.c_230 IS 'Autres produits (cerfa code 230)';
COMMENT ON COLUMN company_financials_screener.c_262 IS 'Autres charges (cerfa code 262)';
COMMENT ON COLUMN company_financials_screener.c_UZ IS 'Sécurité Sociale, autres organismes sociaux (cerfa code UZ)';
COMMENT ON COLUMN company_financials_screener.c_ZJ IS 'Total du poste correspondant à la ligne FW du tableau n° 2052 (cerfa code ZJ)';
COMMENT ON COLUMN company_financials_screener.c_AV IS 'Immobilisations en cours (cerfa code AV)';
COMMENT ON COLUMN company_financials_screener.c_HP IS 'Renvois : Crédit-bail mobilier (cerfa code HP)';
COMMENT ON COLUMN company_financials_screener.c_ST IS 'Autres comptes (cerfa code ST)';
COMMENT ON COLUMN company_financials_screener.c_FM IS 'Production stockée (cerfa code FM)';
COMMENT ON COLUMN company_financials_screener.c_294 IS 'Charges financières (cerfa code 294)';
COMMENT ON COLUMN company_financials_screener.c_SS IS 'Rémunération d’intermédiaires et honoraires (hors rétrocessions) (cerfa code SS)';
COMMENT ON COLUMN company_financials_screener.c_490 IS 'Total Immobilisations (Valeur brute) (cerfa code 490)';
COMMENT ON COLUMN company_financials_screener.c_YX IS 'Total du compte correspondant à la ligne FX du tableau n° 2052 (cerfa code YX)';
COMMENT ON COLUMN company_financials_screener.c_YZ IS 'Total TVA. déductible sur biens et services (cerfa code YZ)';
COMMENT ON COLUMN company_financials_screener.c_182 IS 'Coût de revient des immobilisations acquises ou créées au cours de l’exercice (cerfa code 182)';
COMMENT ON COLUMN company_financials_screener.c_156 IS 'Emprunts et dettes assimilées (cerfa code 156)';
COMMENT ON COLUMN company_financials_screener.c_9Z IS 'Autres impôts, taxes et versements assimilés (cerfa code 9Z)';
COMMENT ON COLUMN company_financials_screener.c_YY IS 'Montant de la TVA. collectée (cerfa code YY)';
COMMENT ON COLUMN company_financials_screener.c_BN IS 'En cours de production de biens (cerfa code BN)';
COMMENT ON COLUMN company_financials_screener.c_XQ IS 'Location, charges locatives et de copropriété (cerfa code XQ)';
COMMENT ON COLUMN company_financials_screener.c_YW IS 'Taxe professionnelle (cerfa code YW)';
COMMENT ON COLUMN company_financials_screener.c_DZ IS 'Dettes sur immobilisations et comptes rattachés (cerfa code DZ)';
COMMENT ON COLUMN company_financials_screener.c_378 IS 'Montant de la T.V.A. déductible sur biens et services (cerfa code 378)';
COMMENT ON COLUMN company_financials_screener.c_BB IS 'Créances rattachées à des participations (cerfa code BB)';
COMMENT ON COLUMN company_financials_screener.c_GD IS 'Dot. d’exploit. Pour risques et charges : dotations aux provisions (cerfa code GD)';
COMMENT ON COLUMN company_financials_screener.c_300 IS 'Charges exceptionnelles (cerfa code 300)';
COMMENT ON COLUMN company_financials_screener.c_234 IS 'Achats de marchandises (y compris droits de douane) (cerfa code 234)';
COMMENT ON COLUMN company_financials_screener.c_HG IS 'Dotations exceptionnelles aux amortissements et provisions (cerfa code HG)';
COMMENT ON COLUMN company_financials_screener.c_374 IS 'Montant de la T.V.A. collectée (cerfa code 374)';
COMMENT ON COLUMN company_financials_screener.c_YT IS 'Sous-traitance (cerfa code YT)';
COMMENT ON COLUMN company_financials_screener.c_6N IS 'Sur stocks et en cours (cerfa code 6N)';
COMMENT ON COLUMN company_financials_screener.c_092 IS 'Charges constatées d’avance (cerfa code 092)';
COMMENT ON COLUMN company_financials_screener.c_132 IS 'Autres réserves (cerfa code 132)';
COMMENT ON COLUMN company_financials_screener.c_CS IS 'Participations évaluées - mise en équivalence (cerfa code CS)';
COMMENT ON COLUMN company_financials_screener.c_238 IS 'Achats de matières premières et autres approvisionnements (y compris droits de douane) (cerfa code 238)';
COMMENT ON COLUMN company_financials_screener.c_A4 IS 'Renvois : Redevances pour concessions de brevets, de licences (charges) (cerfa code A4)';
COMMENT ON COLUMN company_financials_screener.c_HC IS 'Reprises sur provisions et transferts de charges (cerfa code HC)';
COMMENT ON COLUMN company_financials_screener.c_243 IS '(dont taxe professionnelle) (cerfa code 243)';
COMMENT ON COLUMN company_financials_screener.c_280 IS 'Produits financiers (cerfa code 280)';
COMMENT ON COLUMN company_financials_screener.c_BF IS 'Prêts (cerfa code BF)';
COMMENT ON COLUMN company_financials_screener.c_DQ IS 'Provisions pour charges (cerfa code DQ)';
COMMENT ON COLUMN company_financials_screener.c_492 IS 'Total Immobilisations (Augmentations) (cerfa code 492)';
COMMENT ON COLUMN company_financials_screener.c_060 IS 'Stock marchandises (cerfa code 060)';
COMMENT ON COLUMN company_financials_screener.c_5V IS 'Autres provisions pour risques et charges (cerfa code 5V)';
COMMENT ON COLUMN company_financials_screener.c_GQ IS 'Dotations financières sur amortissements et provisions (cerfa code GQ)';
COMMENT ON COLUMN company_financials_screener.c_DK IS 'Provisions réglementées (cerfa code DK)';
COMMENT ON COLUMN company_financials_screener.c_UL IS 'Créances rattachées à des participations (cerfa code UL)';
COMMENT ON COLUMN company_financials_screener.c_BR IS 'Produits intermédiaires et finis (cerfa code BR)';
COMMENT ON COLUMN company_financials_screener.c_4A IS 'Provisions pour litiges (cerfa code 4A)';
COMMENT ON COLUMN company_financials_screener.c_GK IS 'Produits des autres valeurs mobilières et créances de l’actif immobilisé (cerfa code GK)';
COMMENT ON COLUMN company_financials_screener.c_UJ IS 'dont dotations et reprises : - Exceptionnelles (cerfa code UJ)';
COMMENT ON COLUMN company_financials_screener.c_014 IS 'Immobilisations incorporelles – Autres (cerfa code 014)';
COMMENT ON COLUMN company_financials_screener.c_AX IS 'Avances et acomptes (cerfa code AX)';
COMMENT ON COLUMN company_financials_screener.c_210 IS 'Ventes de marchandises – France (cerfa code 210)';
COMMENT ON COLUMN company_financials_screener.c_8J IS 'Dettes sur immobilisations et comptes rattachés (cerfa code 8J)';
COMMENT ON COLUMN company_financials_screener.c_GN IS 'Différences positives de change (cerfa code GN)';
COMMENT ON COLUMN company_financials_screener.c_DJ IS 'Subventions d’investissement (cerfa code DJ)';
COMMENT ON COLUMN company_financials_screener.c_GS IS 'Différences négatives de change (cerfa code GS)';
COMMENT ON COLUMN company_financials_screener.c_UP IS 'Prêts (cerfa code UP)';
COMMENT ON COLUMN company_financials_screener.c_3Z IS 'Total Provisions réglementées (cerfa code 3Z)';
COMMENT ON COLUMN company_financials_screener.c_CR IS 'Parts à plus d’un an (cerfa code CR)';
COMMENT ON COLUMN company_financials_screener.c_DE IS 'Réserves statutaires ou contractuelles (cerfa code DE)';
COMMENT ON COLUMN company_financials_screener.c_HJ IS 'Participation des salariés aux résultats de l’entreprise (IX) (cerfa code HJ)';
COMMENT ON COLUMN company_financials_screener.c_A2 IS 'ACTIF - Créances sur la clientèle (cerfa code A2)';
COMMENT ON COLUMN company_financials_screener.c_195 IS 'Dont dettes à plus d’un an (cerfa code 195)';
COMMENT ON COLUMN company_financials_screener.c_UG IS 'dont dotations et reprises : - Financières (cerfa code UG)';
COMMENT ON COLUMN company_financials_screener.c_236 IS 'Variation de stock (marchandises) (cerfa code 236)';
COMMENT ON COLUMN company_financials_screener.c_290 IS 'Produits exceptionnels (cerfa code 290)';
COMMENT ON COLUMN company_financials_screener.c_GM IS 'Reprises sur provisions et transferts de charges (cerfa code GM)';
COMMENT ON COLUMN company_financials_screener.c_3X IS 'Amortissements dérogatoires (cerfa code 3X)';
COMMENT ON COLUMN company_financials_screener.c_CY IS 'AMORTISSEMENTS Frais d’établissement, et de développement ou de recherche (cerfa code CY)';
COMMENT ON COLUMN company_financials_screener.c_BP IS 'En cours de production de services (cerfa code BP)';
COMMENT ON COLUMN company_financials_screener.c_FN IS 'Production immobilisée (cerfa code FN)';
COMMENT ON COLUMN company_financials_screener.c_I2 IS 'DIMINUTIONS Prêts et immobilisations financières (cerfa code I2)';
COMMENT ON COLUMN company_financials_screener.c_IN IS 'DIMINUTIONS Frais d’établissement, et de développement ou de recherche (cerfa code IN)';
COMMENT ON COLUMN company_financials_screener.c_YU IS 'Personnel extérieur à l’entreprise (cerfa code YU)';
COMMENT ON COLUMN company_financials_screener.c_CZ IS 'ACQUISITIONS Frais d’établissement, et de développement ou de recherche (cerfa code CZ)';
COMMENT ON COLUMN company_financials_screener.c_GO IS 'Produits nets sur cessions de valeurs mobilières de placement (cerfa code GO)';
COMMENT ON COLUMN company_financials_screener.c_AB IS 'Frais d’établissement (cerfa code AB)';
COMMENT ON COLUMN company_financials_screener.c_VN IS 'Autres impôts, taxes versements assimilés (cerfa code VN)';
COMMENT ON COLUMN company_financials_screener.c_GB IS 'Dot. d’exploit. - Dotations aux provisions (cerfa code GB)';
COMMENT ON COLUMN company_financials_screener.c_010 IS 'Immobilisations incorporelles - Fonds commercial (cerfa code 010)';
COMMENT ON COLUMN company_financials_screener.c_ZE IS 'Dividendes (cerfa code ZE)';
COMMENT ON COLUMN company_financials_screener.c_6X IS 'Autres provisions pour dépréciation (cerfa code 6X)';
COMMENT ON COLUMN company_financials_screener.c_DF IS 'Réserves réglementées (1) (cerfa code DF)';
COMMENT ON COLUMN company_financials_screener.c_9U IS 'sur immobilisations – titres de participation (cerfa code 9U)';
COMMENT ON COLUMN company_financials_screener.c_050 IS 'Matières premières, approvisionnements, en cours de production (cerfa code 050)';
COMMENT ON COLUMN company_financials_screener.c_080 IS 'Valeurs mobilières de placement (cerfa code 080)';
COMMENT ON COLUMN company_financials_screener.c_494 IS 'Total Immobilisations (Diminutions) (cerfa code 494)';
COMMENT ON COLUMN company_financials_screener.c_376 IS 'Effectif moyen du personnel (cerfa code 376)';
COMMENT ON COLUMN company_financials_screener.c_472 IS 'AUGMENTATIONS Imm. corporelles – Autres immobilisations corporelles (cerfa code 472)';
COMMENT ON COLUMN company_financials_screener.c_482 IS 'AUGMENTATIONS Immobilisations financières (cerfa code 482)';
COMMENT ON COLUMN company_financials_screener.c_4X IS 'Provisions pour pensions et obligations similaires (cerfa code 4X)';
COMMENT ON COLUMN company_financials_screener.c_442 IS 'AUGMENTATIONS Imm. corporelles – Installations techniques matériel et outillage industriels industriels (cerfa code 442)';
COMMENT ON COLUMN company_financials_screener.c_CX IS 'Frais de développement ou de recherche et développement (cerfa code CX)';
COMMENT ON COLUMN company_financials_screener.c_174 IS 'Produits constatés d’avance (cerfa code 174)';
COMMENT ON COLUMN company_financials_screener.c_GT IS 'Charges nettes sur cessions de valeurs mobilières de placement (cerfa code GT)';
COMMENT ON COLUMN company_financials_screener.c_240 IS 'Variation de stock (matières premières et approvisionnement) (cerfa code 240)';
COMMENT ON COLUMN company_financials_screener.c_462 IS 'AUGMENTATIONS Imm. corporelles – Matériel de transport (cerfa code 462)';
COMMENT ON COLUMN company_financials_screener.c_YQ IS 'Engagement de crédit-bail mobilier (cerfa code YQ)';
COMMENT ON COLUMN company_financials_screener.c_EO IS 'Provisions pour gros entretien et grandes révisions ou grosses réparations (cerfa code EO)';
COMMENT ON COLUMN company_financials_screener.c_199 IS 'Dont comptes courant d’associés débiteurs (cerfa code 199)';
COMMENT ON COLUMN company_financials_screener.c_ED IS '(V) (cerfa code ED)';
COMMENT ON COLUMN company_financials_screener.c_064 IS 'Avances et acomptes versés sur commandes (cerfa code 064)';
COMMENT ON COLUMN company_financials_screener.c_214 IS 'Production vendue de biens – France (cerfa code 214)';
COMMENT ON COLUMN company_financials_screener.c_GH IS 'Bénéfice attribué ou perte transférée (III) (cerfa code GH)';
COMMENT ON COLUMN company_financials_screener.c_226 IS 'Subventions d’exploitation reçues (cerfa code 226)';
COMMENT ON COLUMN company_financials_screener.c_HQ IS 'Renvois : Crédit-bail immobilier (cerfa code HQ)';
COMMENT ON COLUMN company_financials_screener.c_GI IS 'Perte supportée ou bénéfice transféré (IV) (cerfa code GI)';
COMMENT ON COLUMN company_financials_screener.c_CN IS 'Ecarts de conversion actif (V) (cerfa code CN)';
COMMENT ON COLUMN company_financials_screener.c_184 IS 'Prix de vente hors T.V.A. des immobilisations cédées au cours de l’exercice (cerfa code 184)';
COMMENT ON COLUMN company_financials_screener.c_06 IS 'sur immobilisations – autres immobilisations financières (cerfa code 06)';
COMMENT ON COLUMN company_financials_screener.c_4E IS 'Provisions pour garanties données aux clients (cerfa code 4E)';
COMMENT ON COLUMN company_financials_screener.c_YV IS 'Rétrocessions d’honoraires, commissions et courtages (cerfa code YV)';
COMMENT ON COLUMN company_financials_screener.c_A3 IS 'Renvois : Redevances pour concessions de brevets, de licences (produits) (cerfa code A3)';
COMMENT ON COLUMN company_financials_screener.c_DC IS 'Ecarts de réévaluation (cerfa code DC)';
COMMENT ON COLUMN company_financials_screener.c_164 IS 'Avances et acomptes reçus sur commandes en cours (cerfa code 164)';
COMMENT ON COLUMN company_financials_screener.c_596 IS 'Total Immobilisations – Amortissement - Plus-values, Moins-values (Court terme) (cerfa code 596)';
COMMENT ON COLUMN company_financials_screener.c_DT IS 'Autres emprunts obligataires (cerfa code DT)';
COMMENT ON COLUMN company_financials_screener.c_4T IS 'Provisions pour perte de change (cerfa code 4T)';
COMMENT ON COLUMN company_financials_screener.c_6A IS 'sur immobilisations – incorporelles (cerfa code 6A)';
COMMENT ON COLUMN company_financials_screener.c_140 IS 'Provisions réglementées (cerfa code 140)';
COMMENT ON COLUMN company_financials_screener.c_6E IS 'sur immobilisations – corporelles (cerfa code 6E)';
COMMENT ON COLUMN company_financials_screener.c_193 IS 'Dont immobilisations financières à moins d’un an (cerfa code 193)';
COMMENT ON COLUMN company_financials_screener.c_582 IS 'Total Plus-values, Moins-values (Valeur résiduelle) (cerfa code 582)';
COMMENT ON COLUMN company_financials_screener.c_DO IS 'TOTAL (II) (cerfa code DO)';
COMMENT ON COLUMN company_financials_screener.c_ZR IS 'ZR (cerfa code ZR)';
COMMENT ON COLUMN company_financials_screener.c_MY IS 'DIMINUTIONS Virement postes immobilisations corporelles en cours (cerfa code MY)';
COMMENT ON COLUMN company_financials_screener.c_256 IS 'Dotations aux provisions (cerfa code 256)';
COMMENT ON COLUMN company_financials_screener.c_209 IS 'Ventes de marchandises – Export (cerfa code 209)';
COMMENT ON COLUMN company_financials_screener.c_CB IS 'Capital souscrit et appelé, non versé (cerfa code CB)';
COMMENT ON COLUMN company_financials_screener.c_584 IS 'Total Plus-values, Moins-values (Prix de cession) (cerfa code 584)';
COMMENT ON COLUMN company_financials_screener.c_452 IS 'AUGMENTATIONS Imm. corporelles – Installations générales, agencements divers (cerfa code 452)';
COMMENT ON COLUMN company_financials_screener.c_217 IS 'Production vendue de services - Export (cerfa code 217)';
COMMENT ON COLUMN company_financials_screener.c_412 IS 'AUGMENTATIONS Immobilisations incorporelles –Autres immobilisations incorporelles (cerfa code 412)';
COMMENT ON COLUMN company_financials_screener.c_DN IS 'Avances conditionnées (cerfa code DN)';
COMMENT ON COLUMN company_financials_screener.c_24B IS '(dont crédit bail mobilier)* (cerfa code 24B)';
COMMENT ON COLUMN company_financials_screener.c_CW IS 'Charges à répartir ou frais d’émission d’emprunt (cerfa code CW)';
COMMENT ON COLUMN company_financials_screener.c_24A IS '(dont crédit bail immobilier)* (cerfa code 24A)';
COMMENT ON COLUMN company_financials_screener.c_222 IS 'Production stockée (cerfa code 222)';
COMMENT ON COLUMN company_financials_screener.c_7Z IS 'Autres emprunts obligataires brut à un an au plus (cerfa code 7Z)';
COMMENT ON COLUMN company_financials_screener.c_682 IS 'AUGMENTATIONS Total Relevé des provisions (cerfa code 682)';
COMMENT ON COLUMN company_financials_screener.c_088 IS 'Caisse (cerfa code 088)';
COMMENT ON COLUMN company_financials_screener.c_AL IS 'Avances et acomptes sur immobilisations incorporelles (cerfa code AL)';
COMMENT ON COLUMN company_financials_screener.c_154 IS 'Provisions pour risques et charges - Total II (cerfa code 154)';
COMMENT ON COLUMN company_financials_screener.c_Z1 IS 'Créances représentatives de titres prêtés (cerfa code Z1)';
COMMENT ON COLUMN company_financials_screener.c_484 IS 'DIMINUTIONS Immobilisations financières (cerfa code 484)';
COMMENT ON COLUMN company_financials_screener.c_DS IS 'Emprunts obligataires convertibles (cerfa code DS)';
COMMENT ON COLUMN company_financials_screener.c_R1 IS 'Compte de résultat - Intérêts et produits assimilés (cerfa code R1)';
COMMENT ON COLUMN company_financials_screener.c_P2 IS 'P2 (cerfa code P2)';
COMMENT ON COLUMN company_financials_screener.c_432 IS 'AUGMENTATIONS Imm. corporelles – Constructions (cerfa code 432)';
COMMENT ON COLUMN company_financials_screener.c_4J IS 'Provisions pour perte sur marchés à terme (cerfa code 4J)';
COMMENT ON COLUMN company_financials_screener.c_130 IS 'Réserves réglementées (cerfa code 130)';
COMMENT ON COLUMN company_financials_screener.c_124 IS 'Ecarts de réévaluation (cerfa code 124)';
COMMENT ON COLUMN company_financials_screener.c_5R IS 'Provisions pour charges sociales et fiscales sur congés à payer (cerfa code 5R)';
COMMENT ON COLUMN company_financials_screener.c_P3 IS 'P3 (cerfa code P3)';
COMMENT ON COLUMN company_financials_screener.c_684 IS 'DIMINUTIONS Total Relevé des provisions (cerfa code 684)';
COMMENT ON COLUMN company_financials_screener.c_P1 IS 'P1 (cerfa code P1)';
COMMENT ON COLUMN company_financials_screener.c_P7 IS 'PASSIF - Report à nouveau (cerfa code P7)';
COMMENT ON COLUMN company_financials_screener.c_DM IS 'Produit des émissions de titres participatifs (cerfa code DM)';
COMMENT ON COLUMN company_financials_screener.c_R3 IS 'Compte de résultat - Résultat de l’exercice (cerfa code R3)';
COMMENT ON COLUMN company_financials_screener.c_R5 IS 'Résultat net des entreprises intégrées (cerfa code R5)';
COMMENT ON COLUMN company_financials_screener.c_NC IS 'DIMINUTIONS Virement postes - Avances et acomptes (cerfa code NC)';
COMMENT ON COLUMN company_financials_screener.c_224 IS 'Production immobilisée (cerfa code 224)';
COMMENT ON COLUMN company_financials_screener.c_EF IS 'Dont réserve réglementée des plus-values à long terme (cerfa code EF)';
COMMENT ON COLUMN company_financials_screener.c_316 IS 'Rémunération et avantages personnels non déductibles (cerfa code 316)';
COMMENT ON COLUMN company_financials_screener.c_402 IS 'AUGMENTATIONS Immobilisations incorporelles – Fonds commercial (cerfa code 402)';
COMMENT ON COLUMN company_financials_screener.c_P8 IS 'PASSIF - Résultat de l’exercice (cerfa code P8)';
COMMENT ON COLUMN company_financials_screener.c_P9 IS 'TOTAL PASSIF (cerfa code P9)';
COMMENT ON COLUMN company_financials_screener.c_414 IS 'DIMINUTIONS Immobilisations incorporelles –Autres immobilisations incorporelles (cerfa code 414)';
COMMENT ON COLUMN company_financials_screener.c_R2 IS 'Compte de résultat - Intérêts et charges assimilées (cerfa code R2)';
COMMENT ON COLUMN company_financials_screener.c_R6 IS 'Résultat Groupe (Résultat net consolidé) (cerfa code R6)';
COMMENT ON COLUMN company_financials_screener.c_R8 IS 'Résultat net part du groupe (part de la société mère) (cerfa code R8)';
COMMENT ON COLUMN company_financials_screener.c_624 IS 'DIMINUTIONS Provisions pour risques et charges (cerfa code 624)';
COMMENT ON COLUMN company_financials_screener.c_197 IS 'Dont créances à plus d’un an (cerfa code 197)';
COMMENT ON COLUMN company_financials_screener.c_422 IS 'AUGMENTATIONS Imm. corporelles – Terrains (cerfa code 422)';
COMMENT ON COLUMN company_financials_screener.c_7Y IS 'Emprunts obligataires convertibles brut à un an au plus (cerfa code 7Y)';
COMMENT ON COLUMN company_financials_screener.c_P6 IS 'Dans les résultats (cerfa code P6)';
COMMENT ON COLUMN company_financials_screener.c_P5 IS 'PASSIF - Réserves (cerfa code P5)';
COMMENT ON COLUMN company_financials_screener.c_652 IS 'AUGMENTATIONS Provisions pour dépréciation – Sur clients et comptes rattachés (cerfa code 652)';
COMMENT ON COLUMN company_financials_screener.c_AA IS 'Capital souscrit non appelé (cerfa code AA)';
COMMENT ON COLUMN company_financials_screener.c_Z2 IS 'Dette représentative de titres empruntés (cerfa code Z2)';
COMMENT ON COLUMN company_financials_screener.c_UO IS '(provision pour dépréciation antérieurement constituée) (cerfa code UO)';
COMMENT ON COLUMN company_financials_screener.c_215 IS 'Production vendue de biens - Export (cerfa code 215)';
COMMENT ON COLUMN company_financials_screener.c_642 IS 'AUGMENTATIONS Provisions pour dépréciation – Sur stocks et en cours (cerfa code 642)';
COMMENT ON COLUMN company_financials_screener.c_R4 IS 'R4 (cerfa code R4)';
COMMENT ON COLUMN company_financials_screener.c_P4 IS 'PASSIF - Primes d’émission (cerfa code P4)';
COMMENT ON COLUMN company_financials_screener.c_654 IS 'DIMINUTIONS Provisions pour dépréciation – Sur clients et comptes rattachés (cerfa code 654)';
COMMENT ON COLUMN company_financials_screener.c_662 IS 'AUGMENTATIONS Provisions pour dépréciation – Autres provisions pour dépréciation (cerfa code 662)';
COMMENT ON COLUMN company_financials_screener.c_4N IS 'Provisions pour amendes et pénalités (cerfa code 4N)';
COMMENT ON COLUMN company_financials_screener.c_5B IS 'Provisions pour impôts (cerfa code 5B)';
COMMENT ON COLUMN company_financials_screener.c_602 IS 'AUGMENTATIONS Provisions réglementées – Amortissements dérogatoires (cerfa code 602)';
COMMENT ON COLUMN company_financials_screener.c_612 IS 'AUGMENTATIONS Provisions réglementées – Autres provisions réglementées (cerfa code 612)';
COMMENT ON COLUMN company_financials_screener.c_622 IS 'AUGMENTATIONS Provisions pour risques et charges (cerfa code 622)';
COMMENT ON COLUMN company_financials_screener.c_02 IS 'sur immobilisations – titres mis en équivalence (cerfa code 02)';
COMMENT ON COLUMN company_financials_screener.c_VX IS 'Obligations cautionnées (cerfa code VX)';
COMMENT ON COLUMN company_financials_screener.c_632 IS 'AUGMENTATIONS Provisions pour dépréciation – Sur immobilisations (cerfa code 632)';
COMMENT ON COLUMN company_financials_screener.c_YR IS 'Engagement de crédit-bail immobilier (cerfa code YR)';
COMMENT ON COLUMN company_financials_screener.c_YS IS 'Effets portés à l’escompte et non échus (cerfa code YS)';
COMMENT ON COLUMN company_financials_screener.c_644 IS 'DIMINUTIONS Provisions pour dépréciation – Sur stocks et en cours (cerfa code 644)';
COMMENT ON COLUMN company_financials_screener.c_R7 IS 'Part des intérêts minoritaires (Résultat hors groupe) (cerfa code R7)';

