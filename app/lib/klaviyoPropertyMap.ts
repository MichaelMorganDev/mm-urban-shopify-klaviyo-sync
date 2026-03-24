/**
 * Maps Shopify customer metafields (namespace:key) to exact Klaviyo custom property names.
 * Only keys listed here are synced; unknown pairs are ignored.
 */
const SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY: Record<string, string> = {
  "counterpoint:LOY_1": "Loyalty Program 1",
  "counterpoint:LOY_2": "Loyalty Program 2",
  "counterpoint:LOY_3": "Loyalty Program 3",
  "counterpoint:loy_1": "Loyalty Program 1",
  "counterpoint:loy_2": "Loyalty Program 2",
  "counterpoint:loy_3": "Loyalty Program 3",
  "counterpoint:CustomerCateg": "Customer Category",
  "counterpoint:customercateg": "Customer Category",
  "counterpoint:customer_category": "Customer Category",
  "counterpoint:CustomerNumber": "Customer Number",
  "counterpoint:customernumber": "Customer Number",
  "counterpoint:customer_number": "Customer Number",
  "counterpoint:Email": "Email",
  "counterpoint:email": "Email",
  "counterpoint:FirstSaleDate": "First Sale Date ",
  "counterpoint:firstsaledate": "First Sale Date ",
  "counterpoint:first_sale_date": "First Sale Date ",
  "counterpoint:LastSaleDate": "Last Sale Date",
  "counterpoint:lastsaledate": "Last Sale Date",
  "counterpoint:last_sale": "Last Sale Date",
  "counterpoint:last_sale_date": "Last Sale Date",
  "counterpoint:Name": "Name",
  "counterpoint:name": "Name",
  "counterpoint:PhoneNumber": "Phone Number",
  "counterpoint:phonenumber": "Phone Number",
  "counterpoint:phone_number": "Phone Number",
  "counterpoint:StoreID": "Store ID",
  "counterpoint:storeid": "Store ID",
  "counterpoint:store_id": "Store ID",
  "klaviyo:First_Sale_Date": "First Sale Date",
  "klaviyo:Date_of_Birth": "Date of Birth",
};

export function getKlaviyoPropertyName(
  namespace: string,
  key: string,
): string | undefined {
  return SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY[`${namespace}:${key}`];
}

export function getAllMappedShopifyMetafieldKeys(): string[] {
  return Object.keys(SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY);
}
