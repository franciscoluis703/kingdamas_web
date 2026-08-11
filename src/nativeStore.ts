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

declare global {
  interface Window {
    Capacitor?: {
      getPlatform?: () => string;
      isNativePlatform?: () => boolean;
      Plugins?: { KingDamasStore?: KingDamasStorePlugin };
    };
  }
}

function storePlugin() {
  return window.Capacitor?.Plugins?.KingDamasStore;
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
