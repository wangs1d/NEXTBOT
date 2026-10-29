/**
 * 统一预订服务抽象层（方案 A）公共出口。
 */

export type {
  BookingDomain,
  BookingOrderStatus,
  BookingOption,
  BookingSearchQuery,
  BookingDraft,
  BookingProvider,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderBookPayload,
  BookingProviderStatusPayload,
} from "./booking-provider.js";
export { BOOKING_TERMINAL_STATUSES } from "./booking-provider.js";
export { getBookingConfig, type BookingConfig } from "./booking-config.js";
export { BookingOrderStore, newBookingOrderId, type StoredBookingOrder } from "./booking-order-store.js";
export {
  BookingConfirmationStore,
  type BookingPendingConfirmation,
} from "./booking-confirmation.js";
export { BookingService, type BookingServiceResult, type BookingServiceDeps } from "./booking-service.js";
export { buildDefaultBookingProviders } from "./providers/index.js";
export { SimulatedRideProvider } from "./providers/simulated-ride-provider.js";
export {
  SimulatedHomeServiceProvider,
  SimulatedRestaurantProvider,
  HOME_SERVICE_TYPES,
} from "./providers/simulated-local-providers.js";
export { AmapRideProvider } from "./providers/amap-ride-provider.js";
export { AmapRestaurantProvider } from "./providers/amap-restaurant-provider.js";
