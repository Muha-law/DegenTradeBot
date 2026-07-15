#!/usr/bin/env python3
"""
Retrains src/ai/ourRugModelArtifact.json from our own closed-trade history.

Usage:
  railway ssh "node scripts/extractRugTrainingData.mjs" > trainingData.json
  python3 scripts/trainRugModel.py trainingData.json

Requires: pip install scikit-learn numpy

Label: exit_reason == "stale_price" (our own dead-pool/rug detector — see
paperTrading.js). Reports both a repeated stratified k-fold AUC and a
chronological held-out AUC (train on the older 70% of calls by entry_at,
test on strictly newer ones) before writing the artifact — a high k-fold
number alone isn't trustworthy at small n; the chronological split is the
harder, more honest test and is what should actually be trusted.
"""
import json
import sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score

if len(sys.argv) < 2:
    print("Usage: python3 trainRugModel.py <trainingData.json>")
    sys.exit(1)

with open(sys.argv[1]) as f:
    rows = json.load(f)

CHAINS = sorted(set(r["chain"] for r in rows))
print("Chains seen in training data:", CHAINS)


def build_features(r):
    liq = r["call_liquidity_usd"] or 0
    vol = r["call_volume24h_usd"] or 0
    mc = r["call_market_cap_usd"] or 0
    risk = r["risk_score"] or 0
    vol_liq_ratio = vol / liq if liq > 0 else 0
    chain_onehot = [1.0 if r["chain"] == c else 0.0 for c in CHAINS]
    return [liq, vol, mc, vol_liq_ratio, risk] + chain_onehot


X = np.array([build_features(r) for r in rows], dtype=float)
y = np.array([1 if r["exit_reason"] == "stale_price" else 0 for r in rows], dtype=int)
feature_names = ["liq", "vol", "mc", "vol_liq_ratio", "risk_score"] + [f"chain_{c}" for c in CHAINS]

print("n =", len(y), "| rugs =", int(y.sum()), "| rug rate =", round(float(y.mean()), 3))
if len(y) < 50:
    print("WARNING: fewer than 50 labeled examples — treat any AUC here as very rough.")

N_REPEATS = 20
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

logreg_aucs, gbt_aucs = [], []
for repeat in range(N_REPEATS):
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=repeat)
    logreg_probs = cross_val_predict(LogisticRegression(max_iter=2000, C=1.0), X_scaled, y, cv=cv, method="predict_proba")[:, 1]
    logreg_aucs.append(roc_auc_score(y, logreg_probs))
    gbt_probs = cross_val_predict(HistGradientBoostingClassifier(max_depth=3, max_iter=100, random_state=repeat), X, y, cv=cv, method="predict_proba")[:, 1]
    gbt_aucs.append(roc_auc_score(y, gbt_probs))

logreg_auc = float(np.mean(logreg_aucs))
print(f"\nLogistic Regression cross-validated AUC (5-fold x {N_REPEATS} repeats): {logreg_auc:.3f} (std {np.std(logreg_aucs):.3f})")
print(f"Gradient Boosted Trees cross-validated AUC (5-fold x {N_REPEATS} repeats): {np.mean(gbt_aucs):.3f} (std {np.std(gbt_aucs):.3f})")

# Chronological held-out test — the one to actually trust
order = np.argsort([r["entry_at"] for r in rows])
X_sorted, y_sorted = X[order], y[order]
split = int(len(y_sorted) * 0.7)
X_train, X_test = X_sorted[:split], X_sorted[split:]
y_train, y_test = y_sorted[:split], y_sorted[split:]
print(f"\nChronological split: train n={len(y_train)} (rug rate {y_train.mean():.2f}), test n={len(y_test)} (rug rate {y_test.mean():.2f})")

chron_scaler = StandardScaler().fit(X_train)
chron_model = LogisticRegression(max_iter=2000, C=1.0).fit(chron_scaler.transform(X_train), y_train)
if len(set(y_test)) > 1:
    chron_auc = roc_auc_score(y_test, chron_model.predict_proba(chron_scaler.transform(X_test))[:, 1])
    print(f"Logistic Regression chronological held-out AUC: {chron_auc:.3f}  <-- trust this number most")
else:
    chron_auc = None
    print("Chronological test set has only one class — AUC undefined this run.")

# Fit final model on ALL data for deployment
final_scaler = StandardScaler().fit(X)
final_model = LogisticRegression(max_iter=2000, C=1.0).fit(final_scaler.transform(X), y)

artifact = {
    "featureOrder": feature_names,
    "numericFeatures": ["liq", "vol", "mc", "vol_liq_ratio", "risk_score"],
    "categoricalFeatures": ["chain"],
    "categoricalValues": {"chain": CHAINS},
    "scalerMean": final_scaler.mean_.tolist(),
    "scalerScale": final_scaler.scale_.tolist(),
    "coefficients": final_model.coef_[0].tolist(),
    "intercept": float(final_model.intercept_[0]),
    "volLiqRatioMedianFallback": float(np.median([f[3] for f in X])),
    "trainedOn": {"n": len(y), "rugRate": float(y.mean())},
    "crossValidatedAuc": logreg_auc,
    "chronologicalHoldoutAuc": chron_auc,
}

out_path = "src/ai/ourRugModelArtifact.json"
with open(out_path, "w") as f:
    json.dump(artifact, f, indent=2)
print("\nWrote", out_path)
