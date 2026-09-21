// Mintsoft API models.
//
// GENERATED from https://api.mintsoft.co.uk/swagger/docs/v1 (x-swagger-net-version 8.5.28.001).
// Do not hand-edit — run `npm run gen:types`.
//
// Field names and casing are verbatim from the spec. Mintsoft is case-sensitive and
// several names are easy to get wrong, including one the API itself misspells
// (`ASNItem.QuantityReceieved`). Matching their spelling is deliberate.
//
// Almost every property is optional: the spec marks very few fields required, so the
// API may omit any of them. Treat a missing number as unknown, never as 0 — the portal
// renders unknown stock as an em dash, and a silent 0 would read as "out of stock".

export interface ASN {
  CLIENTSHORTNAME?: string;
  POReference?: string;
  Supplier?: string;
  ProductSupplierId?: number;
  ProductSupplier?: string;
  EstimatedDelivery?: string; // date-time
  EstimatedTimeToDock?: string; // date-time
  WarehouseBookedDate?: string; // date-time
  BookedInDate?: string; // date-time
  Comments?: string;
  GoodsInType?: string;
  Quantity?: number;
  ASNStatus?: ASNStatus;
  ASNStatusId?: number;
  Shipped?: boolean;
  HoursLogged?: number;
  Items?: ASNItem[];
  WarehouseId?: number;
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ASNItem {
  ASNId?: number;
  ProductId?: number;
  QuantityExpected?: number;
  QuantityReceieved?: number;
  QuantityBooked?: number;
  OnOrder?: number;
  SSCCNumber?: string;
  Complete?: boolean;
  Comments?: string;
  SourceLineId?: string;
  ASNItemNameValues?: ASNItemNameValue[];
  SKU?: string;
  EAN?: string;
  UPC?: string;
  NAME?: string;
  HasSerialNumber?: boolean;
  HasExpiryDate?: boolean;
  HasBatchNumber?: boolean;
  ProductImageURL?: string;
  ASNItemAllocations?: ASNItemAllocation[];
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ASNItemAllocation {
  ASNItemId?: number;
  Quantity?: number;
  LocationId?: number;
  ExpiryDate?: string; // date-time
  BatchNo?: string;
  SerialNo?: string;
  Complete?: boolean;
  RobotPutaway?: boolean;
  StorageItemId?: number;
  ProductId?: number;
  SKU?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ASNItemNameValue {
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ASNStatus {
  Name?: string;
  Colour?: string;
  TextColour?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface BulkInventoryItem {
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
  ProductId?: number;
  StockLevel?: number;
  Allocated?: number;
  OnHand?: number;
  OffHand?: number;
  AwaitingReplen?: number;
  OnOrder?: number;
  RequiredByBackOrder?: number;
  InQuarantine?: number;
  InTransit?: number;
  InTransition?: number;
  Scrapped?: number;
  SKU?: string;
  WarehouseId?: number;
  LocationId?: number;
  ClientId?: number;
  ClientName?: string;
  WarehouseName?: string;
  Breakdown?: StockLevelBreakdown[];
}

export interface CashOnDelivery {
  Amount?: number;
  CurrencyCode?: string;
}

export interface Channel {
  Name: string;
  Description?: string;
  Active?: boolean;
  Logo?: string;
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface Client {
  ShortName: string;
  Name: string;
  Code?: string;
  BrandName?: string;
  ContactName?: string;
  ContactNumber?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  Town?: string;
  County?: string;
  Postcode?: string;
  PPINumber?: string;
  VATNumber?: string;
  EORINumber?: string;
  UKIMSNumber?: string;
  VOECNumber?: string;
  DefaultMIDCode?: string;
  VatExempt?: boolean;
  NIREORINumber?: string;
  IOSSNumber?: string;
  CountryId?: number;
  ContactEmail?: string;
  PackagingInstructions?: string;
  CurrencyId?: number;
  Active?: string;
  OnStop?: boolean;
  AccountingIntegrationType?: string;
  CustomerRegistrationNumber?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface CommodityCode {
  Code?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface Country {
  Name?: string;
  Code?: string;
  Code3?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface CourierService {
  CourierServiceTypeId?: number;
  Name?: string;
  TrackingURL?: string;
  ActiveB?: boolean;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface Currency {
  Name: string;
  Code: string;
  Symbol?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface InventoryItem {
  ProductId?: number;
  StockLevel?: number;
  Allocated?: number;
  OnHand?: number;
  OffHand?: number;
  AwaitingReplen?: number;
  OnOrder?: number;
  RequiredByBackOrder?: number;
  InQuarantine?: number;
  InTransit?: number;
  InTransition?: number;
  Scrapped?: number;
  SKU?: string;
  WarehouseId?: number;
  LocationId?: number;
  Breakdown?: StockLevelBreakdown[];
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface MintsoftAuthRequest {
  Username?: string;
  Password?: string;
}

export interface NewOrderConnectAction {
  Type?: string;
  SourceOrderId?: string;
  Complete?: boolean;
  AccountId?: number;
  ExtraCode1?: string;
  ExtraCode2?: string;
  ExtraCode3?: string;
  ExtraCode4?: string;
  ExtraCode5?: string;
  ExtraFlag1?: boolean;
  ExtraFlag2?: boolean;
  Messages?: string;
  ExtraDate1?: string; // date-time
}

export interface NewOrderItem {
  SKU?: string;
  ProductId?: number;
  Quantity?: number;
  Details?: string;
  UnitPrice?: number;
  UnitPriceVat?: number;
  Discount?: number;
  OrderItemNameValues?: NewOrderItemNameValue[];
  WarehouseId?: number;
  RequestedSerialNo?: string;
  RequestedBatchNo?: string;
  RequestedBBEDate?: string;
}

export interface NewOrderItemNameValue {
  Name?: string;
  Value?: string;
}

export interface NewOrderNameValue {
  Name?: string;
  Value?: string;
}

export interface NewOrderResult {
  OrderId?: number;
  DropShipOrderId?: number;
  OrderNumber?: string;
  Success?: boolean;
  OrderStatusId?: number;
  OrderStatus?: string;
  Message?: string;
  OrderItems?: NewOrderResultItems[];
}

export interface NewOrderResultItems {
  SKU?: string;
  ID?: number;
}

export interface NewOrderWithItems {
  OrderItems?: NewOrderItem[];
  OrderNameValues?: NewOrderNameValue[];
  Tags?: string;
  ConnectAction?: NewOrderConnectAction;
  OrderNumber?: string;
  ExternalOrderReference?: string;
  Title?: string;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  Address1?: string;
  Address2?: string;
  Address3?: string;
  Town?: string;
  County?: string;
  PostCode?: string;
  Country?: string;
  CountryId?: number;
  Email?: string;
  Phone?: string;
  Mobile?: string;
  CourierService?: string;
  CourierServiceId?: number;
  Channel?: string;
  ChannelId?: number;
  Warehouse?: string;
  WarehouseId?: number;
  Currency?: string;
  CurrencyId?: number;
  DeliveryDate?: string; // date-time
  DespatchDate?: string; // date-time
  RequiredDeliveryDate?: string; // date-time
  RequiredDespatchDate?: string; // date-time
  Comments?: string;
  DeliveryNotes?: string;
  GiftMessages?: string;
  VATNumber?: string;
  EORINumber?: string;
  PIDNumber?: string;
  UKIMSNumber?: string;
  RFCNumber?: string;
  IOSSNumber?: string;
  OrderValue?: number;
  ShippingTotalExVat?: number;
  ShippingTotalVat?: number;
  DiscountTotalExVat?: number;
  DiscountTotalVat?: number;
  TotalVat?: number;
  ClientId?: number;
  NumberOfParcels?: number;
  CashOnDelivery?: CashOnDelivery;
  RecipientType?: string;
  NationalAddressField?: string;
}

export interface Order {
  ClientId: number;
  CLIENT_CODE?: string;
  OrderNumber: string;
  ExternalOrderReference?: string;
  OrderDate?: string; // date-time
  DespatchDate?: string; // date-time
  AtNewDate?: string; // date-time
  SLAWarningDate?: string; // date-time
  SLADespatchDate?: string; // date-time
  RequiredDespatchDate?: string; // date-time
  RequiredDeliveryDate?: string; // date-time
  Title?: string;
  FirstName: string;
  LastName?: string;
  CompanyName?: string;
  Address1: string;
  Address2?: string;
  Address3?: string;
  Town?: string;
  County?: string;
  PostCode: string;
  Phone?: string;
  Mobile?: string;
  Email?: string;
  CountryId: number;
  Country?: Country;
  Source?: string;
  Comments?: string;
  GiftMessages?: string;
  DeliveryNotes?: string;
  VATNumber?: string;
  EORINumber?: string;
  UKIMSNumber?: string;
  RFCNumber?: string;
  PIDNumber?: string;
  OrderStatusId?: number;
  NumberOfParcels?: number;
  TotalItems?: number;
  TotalWeight?: number;
  OrderValue?: number;
  Part?: number;
  NumberOfParts?: number;
  CourierServiceTypeId: number;
  CourierServiceId?: number;
  CourierServiceName?: string;
  TrackingNumber?: string;
  TrackingURL?: string;
  ShippingTotalExVat?: number;
  ShippingTotalVat?: number;
  DiscountTotalExVat?: number;
  DiscountTotalVat?: number;
  TotalVat?: number;
  PIIRemoved?: boolean;
  ShippingNet?: number;
  ShippingTax?: number;
  ShippingGross?: number;
  DiscountNet?: number;
  DiscountTax?: number;
  TotalOrderNet?: number;
  TotalOrderTax?: number;
  TotalOrderGross?: number;
  DiscountGross?: number;
  WarehouseId?: number;
  WAREHOUSE_CODE?: string;
  ChannelId?: number;
  Channel?: Channel;
  CurrencyId?: number;
  Currency?: Currency;
  DespatchedByUser?: string;
  OrderItems?: OrderItem[];
  OrderNameValues?: OrderNameValue[];
  OrderLock?: boolean;
  RecipientType?: RecipientTypeLegacyObject;
  Tags?: string;
  SourceOrderDate?: string; // date-time
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderItem {
  OrderId?: number;
  ProductId?: number;
  Quantity?: number;
  Allocated?: number;
  Commited?: number;
  OnBackOrder?: number;
  SourceLineSubTotal?: number;
  SourceLineTotalTax?: number;
  SourceLineTotalDiscount?: number;
  SourceLineTotal?: number;
  Price?: number;
  Vat?: number;
  Discount?: number;
  PriceNet?: number;
  Tax?: number;
  DiscountGross?: number;
  TaxRate?: number;
  DiscountNet?: number;
  DiscountTax?: number;
  NetPaid?: number;
  TaxPaid?: number;
  TotalTax?: number;
  Details?: string;
  SKU?: string;
  OrderItemNameValues?: OrderItemNameValue[];
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderItemNameValue {
  Name?: string;
  Value?: string;
  Internal?: boolean;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderNameValue {
  OrderId?: number;
  Name?: string;
  Value?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderShipment {
  OrderId?: number;
  OrderDocumentId?: number;
  DangerousDocumentId?: number;
  CourierType?: string;
  AccountId?: number;
  Number?: string;
  ExtraBool1?: boolean;
  ExtraBool2?: boolean;
  ExtraInt1?: number;
  ExtraInt2?: number;
  ExtraString1?: string;
  ExtraString2?: string;
  CommercialInvoiceId?: number;
  ReturnLabelId?: number;
  ReturnLabelBarcode?: string;
  DownloadTrackingEvents?: boolean;
  RequiresManifesting?: boolean;
  Manifested?: boolean;
  ShipmentDate?: string; // date-time
  LabelURL?: string;
  ParcelNumbers?: string[];
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderShipmentTrackingEvent {
  OrderShipmentId?: number;
  OrderShipment?: OrderShipment;
  TrackingStatusId?: number;
  CourierCustomerDescription?: string;
  CourierExternalDescription?: string;
  CourierTrackingStageCode?: string;
  CourierTrackingEventId?: string;
  CourierTimeStamp?: string; // date-time
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface OrderStatus {
  Name?: string;
  ExternalName?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface Product {
  SKU: string;
  Name?: string;
  PalletSizes?: string;
  PackingInstructions?: string;
  Description?: string;
  CustomsDescription?: string;
  MIDCode?: string;
  CountryOfManufactureId?: number;
  CountryOfManufacture?: Country;
  EAN?: string;
  UPC?: string;
  LowStockAlertLevel?: number;
  Weight: number;
  Height?: number;
  Width?: number;
  Depth?: number;
  Volume?: number;
  BackOrder?: boolean;
  Bundle?: boolean;
  DisCont?: boolean;
  Price?: number;
  CostPrice?: number;
  VatExempt?: boolean;
  AdditionalParcelsRequired?: number;
  UnitsPerParcel?: number;
  HasBatchNumber?: boolean;
  LogBatchInbound?: boolean;
  LogBatchOutbound?: boolean;
  HasSerialNumber?: boolean;
  LogSerialInbound?: boolean;
  LogSerialOutbound?: boolean;
  HasExpiryDate?: boolean;
  LogExpiryDateInbound?: boolean;
  LogExpiryDateOutbound?: boolean;
  BestBeforeDateWarningPeriodDays?: number;
  CommodityCode?: CommodityCode;
  HandlingTime?: number;
  ToteCapacity?: number;
  UnNumber?: string;
  ImageURL?: string;
  SyncStockFrom?: string; // date-time
  ProductHazardousGoods?: ProductHazardousGoods;
  ProductPurchasingSettings?: ProductPurchasingSettings;
  ProductGrowthRates?: ProductGrowthRates[];
  OrderItems?: OrderItem[];
  Subscription?: boolean;
  SubscriptionLength?: number;
  SubscriptionFrequency?: string;
  ProductInCategories?: ProductInCategory[];
  ProductPrices?: ProductPrice[];
  ProductSuppliers?: ProductInSupplier[];
  ProductCustomFields?: ProductCustomField[];
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductCategory {
  Name?: string;
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductCustomField {
  ProductId?: number;
  CustomField?: string;
  Name?: string;
  Value?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductGrowthRates {
  ProductId?: number;
  Product?: Product;
  WeekNo?: number;
  SalesGrowth?: number;
  SeasonalGrowth?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductHazardousGoods {
  ProductID?: number;
  HazardousUnNumber?: string;
  HazardousUnNumberPrefixed?: string;
  HazardousClass?: string;
  HazardousProperShippingName?: string;
  HazardousPackingCode?: string;
  HazardousTunnelCode?: string;
  HazardousLimitedQuantity?: string;
  HazardousFullProperShippingCode?: string;
  HazardousContentId?: string;
  HazardousNotes?: string;
  LitresPerUnit?: number;
  PackagingDescription?: string;
  PackagingInstructions?: string;
  FreezingPoint?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductInCategory {
  ProductId?: number;
  ProductCategoryId?: number;
  ProductCategory?: ProductCategory;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductInSupplier {
  ProductId?: number;
  ProductSupplierId?: number;
  ProductSupplier?: ProductSupplier;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductPrice {
  ProductId?: number;
  Price?: number;
  ProductPriceTypeId?: number;
  ProductPriceType?: ProductPriceType;
  CurrencyId?: number;
  Currency?: Currency;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductPriceType {
  Name?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface ProductPurchasingSettings {
  DefaultMinOrderQty?: number;
  DefaultMaxOrderQty?: number;
  DefaultOrderQty?: number;
  IncludeLinkedItems?: boolean;
  ExcludeFromForecast?: boolean;
  ForecastPeriodDays?: number;
  LeadTimeDays?: number;
  AvgDailyConsumption?: number;
}

export interface ProductSupplier {
  Name?: string;
  ContactName?: string;
  ContactNumber?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  Town?: string;
  County?: string;
  Postcode?: string;
  CountryId?: number;
  Country?: Country;
  ContactEmail?: string;
  Active?: boolean;
  Code?: string;
  CurrencyId?: number;
  Currency?: Currency;
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface RecipientTypeLegacyObject {
  Name?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}

export interface StockLevel {
  ProductId?: number;
  WarehouseId?: number;
  ClientId?: number;
  SKU?: string;
  Level?: number;
  TotalStockLevel?: number;
  PreOrderable?: boolean;
  Bundle?: boolean;
  LowStockLevel?: number;
  LastUpdated?: string; // date-time
  Breakdown?: StockLevelBreakdown[];
}

export interface StockLevelBreakdown {
  Quantity?: number;
  BatchNo?: string;
  SerialNo?: string;
  BestBefore?: string;
  Type?: string;
}

export interface Warehouse {
  Name: string;
  Code?: string;
  Details?: string;
  AllowTransfersIn?: boolean;
  AllowAllocatedTransfers?: boolean;
  AllowUnassignedLocations?: boolean;
  AllocateBasedOnLocationTypePriority?: boolean;
  IncludeAllocatedStockInReplenPoint?: boolean;
  VerifyLocationsWhenPicking?: boolean;
  Active?: boolean;
  Type?: string;
  PrependWarehouseName?: boolean;
  AddressLine1: string;
  AddressLine2?: string;
  City: string;
  County?: string;
  PostCode: string;
  CompanyName: string;
  ContactName: string;
  ContactNumber: string;
  ContactEmail: string;
  CountryId?: number;
  ClientId?: number;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
  WarehouseReferenceFields?: WarehouseReferenceField[];
}

export interface WarehouseReferenceField {
  WarehouseId?: number;
  Name?: string;
  Value?: string;
  Connection?: string;
  ID?: number;
  LastUpdated?: string; // date-time
  LastUpdatedByUser?: string;
}
