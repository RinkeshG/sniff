-- Sniff standing integrity audit. Every check MUST return violations = 0.
-- Run after any import/cutover (and on a schedule) so a wrong-data class fails
-- loudly instead of a user catching it on the site. NULL-safe: absent JSON keys
-- are coalesced, so "verified" filtering never silently drops rows (the bug that
-- hid these very issues the first time).
--
-- Checks the LIVE `analysis` column. To audit staging, swap `analysis` -> `analysis_v2`.

WITH p AS (
  SELECT
    slug, brand, title, category, life_stage, data_completeness, source_url,
    analysis AS a,
    coalesce((analysis->>'unverified')='true', false) AS unver,
    analysis->'verdict'->>'tag'   AS vtag,
    analysis->'verdict'->>'label' AS vlabel,
    lower(trim(analysis->'metrics'->0->>'value')) AS first_ing,
    analysis->'metrics'->1->>'value' AS protein_metric,
    NULLIF(extracted_facts->'ga'->>'protein','')::numeric  AS protein,
    NULLIF(extracted_facts->'ga'->>'fat','')::numeric      AS fat,
    NULLIF(extracted_facts->'ga'->>'fibre','')::numeric    AS fibre,
    NULLIF(extracted_facts->'ga'->>'moisture','')::numeric AS moisture,
    NULLIF(extracted_facts->'ga'->>'ash','')::numeric      AS ash
  FROM products
  WHERE analysis IS NOT NULL
),
junk(tok) AS (
  SELECT unnest(ARRAY[
    'this','that','and','the','with','varies','named meat','real','composition',
    'ingredients','ingredient','ocean','kitten','baby','urinary','hairball','special',
    'creamy','persian','sterilised','sterilized','neutered','adult','senior','mature',
    'indoor','outdoor','care','formula','premium','gold','plus','mix','duo',
    'farmina','inaba','whiskas','sheba','drools','applaws','royal','canin','me-o','meo',
    'purepet','iams','orijen','acana','josera','reflex'])
)
SELECT 'display tag contradicts product form' AS check, count(*) AS violations,
       (array_agg(slug ORDER BY slug))[1:8] AS sample
  FROM p WHERE NOT unver AND ((vtag='wet food' AND category='dry')
                           OR (vtag='dry food' AND category IN ('wet','gravy')))
UNION ALL
SELECT 'dry product carries wet-level moisture (>=45%)', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE NOT unver AND category='dry' AND moisture >= 45
UNION ALL
SELECT 'wet product, verified FULL, no moisture (unsound DM math)', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE NOT unver AND category IN ('wet','gravy') AND data_completeness='full' AND moisture IS NULL
UNION ALL
SELECT 'cat product sourced from a dog-food URL', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE NOT unver AND source_url ~* '(^|[-/_])dog([-/_]|$)|dog-food'
UNION ALL
SELECT 'first ingredient is a junk/title/brand token', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE NOT unver AND first_ing IN (SELECT tok FROM junk)
UNION ALL
SELECT 'Strong/Good verdict without confirmed protein', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE vlabel IN ('Strong choice','Good enough') AND coalesce(protein_metric,'Not disclosed')='Not disclosed'
UNION ALL
SELECT 'guaranteed analysis components sum over 103%', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE coalesce(protein,0)+coalesce(fat,0)+coalesce(fibre,0)+coalesce(moisture,0)+coalesce(ash,0) > 103
UNION ALL
SELECT 'analysis contains an em-dash', count(*), (array_agg(slug ORDER BY slug))[1:8]
  FROM p WHERE a::text ~ '[—–]'
ORDER BY 1;
