export interface NativeStoreProduct {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;
  price: number;
  currencyCode: string;
  type: string;
}

export interface NativeStoreTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  appAccountToken: string;
  purchaseDate: string;
  environment: string;
  signedTransactionInfo: string;
}

export type NativePurchaseResult =
  | { state: "purchased"; transaction: NativeStoreTransaction }
  | { state: "pending" | "cancelled"; transaction?: never };

export interface NativeSubscriptionStatus {
  active: boolean;
  productId: string;
  expirationDate: string | null;
  environment?: string;
  transactionId?: string | null;
  originalTransactionId?: string | null;
  appAccountToken?: string | null;
  signedTransactionInfo?: string | null;
  signedRenewalInfo?: string | null;
}

export type NativeSubscriptionPurchaseResult =
  | { state: "purchased"; subscription: NativeSubscriptionStatus }
  | { state: "pending" | "cancelled"; subscription?: never };

export interface NativeAdsStatus {
  supported: boolean;
  adFree: boolean;
  canRequestAds: boolean;
  privacyOptionsRequired: boolean;
  environment: "development" | "production";
}

interface PluginListenerHandle {
  remove: () => Promise<void>;
}

interface KingDamasStorePlugin {
  getProducts: (options: { productIds: string[] }) => Promise<{
    products: NativeStoreProduct[];
  }>;
  purchase: (options: {
    productId: string;
    appAccountToken: string;
  }) => Promise<NativePurchaseResult>;
  subscriptionStatus: () => Promise<NativeSubscriptionStatus>;
  purchaseSubscription: (options: {
    productId: string;
    appAccountToken: string;
  }) => Promise<NativeSubscriptionPurchaseResult>;
  restoreSubscriptions: () => Promise<NativeSubscriptionStatus>;
  manageSubscriptions: () => Promise<{ presented: boolean }>;
  unfinishedTransactions: () => Promise<{
    transactions: NativeStoreTransaction[];
  }>;
  finish: (options: { transactionId: string }) => Promise<{
    finished: boolean;
  }>;
  addListener?: (
    eventName: "transactionUpdated",
    listener: (transaction: NativeStoreTransaction) => void,
  ) => Promise<PluginListenerHandle>;
}

interface KingDamasAdsPlugin {
  status: () => Promise<NativeAdsStatus>;
  setPremiumStatus: (options: { active: boolean }) => Promise<{ active: boolean }>;
  showInterstitial: () => Promise<{ shown: boolean; reason?: string }>;
  showBanner: () => Promise<{ shown: boolean; reason?: string }>;
  hideBanner: () => Promise<{ hidden: boolean }>;
  showPrivacyOptions: () => Promise<{ presented: boolean }>;
}

declare global {
  interface Window {
    Capacitor?: {
      getPlatform?: () => string;
      isNativePlatform?: () => boolean;
      Plugins?: {
        KingDamasStore?: KingDamasStorePlugin;
        KingDamasAds?: KingDamasAdsPlugin;
      };
    };
  }
}

function storePlugin() {
  return window.Capacitor?.Plugins?.KingDamasStore;
}

function adsPlugin() {
  return window.Capacitor?.Plugins?.KingDamasAds;
}

export function isIOSNativeStoreAvailable() {
  return Boolean(
    isIOSNativeApp() && storePlugin(),
  );
}

export function isIOSNativeApp() {
  const capacitor = window.Capacitor;
  return Boolean(
    capacitor?.getPlatform?.() === "ios" && capacitor.isNativePlatform?.(),
  );
}

export function isAndroidNativeApp() {
  const capacitor = window.Capacitor;
  return Boolean(
    capacitor?.getPlatform?.() === "android" && capacitor.isNativePlatform?.(),
  );
}

// Los anuncios (KingDamasAds) tienen la misma interfaz en iOS y Android.
// Las compras (KingDamasStore) todavía solo estan resueltas del lado del
// servidor para iOS, por eso isIOSNativeStoreAvailable se mantiene aparte.
export function isNativeAdsAvailable() {
  return isIOSNativeApp() || isAndroidNativeApp();
}

export async function nativeStoreProducts(productIds: string[]) {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    throw new Error("App Store solo está disponible en la aplicación para iOS.");
  }
  return (await plugin.getProducts({ productIds })).products;
}

export async function purchaseNativeStoreProduct(
  productId: string,
  appAccountToken: string,
) {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    throw new Error("App Store solo está disponible en la aplicación para iOS.");
  }
  return plugin.purchase({ productId, appAccountToken });
}

export async function nativeSubscriptionStatus() {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    return { active: false, productId: "", expirationDate: null };
  }
  return plugin.subscriptionStatus();
}

export async function purchaseNativeSubscription(
  productId: string,
  appAccountToken: string,
) {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    throw new Error("Las suscripciones solo están disponibles en la aplicación para iOS.");
  }
  return plugin.purchaseSubscription({ productId, appAccountToken });
}

export async function restoreNativeSubscriptions() {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    throw new Error("Las suscripciones solo están disponibles en la aplicación para iOS.");
  }
  return plugin.restoreSubscriptions();
}

export async function manageNativeSubscriptions() {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) {
    throw new Error("Las suscripciones solo están disponibles en la aplicación para iOS.");
  }
  return (await plugin.manageSubscriptions()).presented;
}

export async function nativeAdsStatus() {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return null;
  return plugin.status();
}

export async function setNativeAdsPremiumStatus(active: boolean) {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return false;
  return (await plugin.setPremiumStatus({ active })).active;
}

export async function showNativeGameInterstitial() {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return false;
  return (await plugin.showInterstitial()).shown;
}

export async function showNativeAdBanner() {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return false;
  return (await plugin.showBanner()).shown;
}

export async function hideNativeAdBanner() {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return false;
  return (await plugin.hideBanner()).hidden;
}

export async function showNativeAdPrivacyOptions() {
  const plugin = adsPlugin();
  if (!isNativeAdsAvailable() || !plugin) return false;
  return (await plugin.showPrivacyOptions()).presented;
}

export async function unfinishedNativeStoreTransactions() {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) return [];
  return (await plugin.unfinishedTransactions()).transactions;
}

export async function finishNativeStoreTransaction(transactionId: string) {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin) return false;
  return (await plugin.finish({ transactionId })).finished;
}

export async function listenForNativeStoreTransactions(
  listener: (transaction: NativeStoreTransaction) => void,
) {
  const plugin = storePlugin();
  if (!isIOSNativeStoreAvailable() || !plugin?.addListener) return null;
  return plugin.addListener("transactionUpdated", listener);
}
