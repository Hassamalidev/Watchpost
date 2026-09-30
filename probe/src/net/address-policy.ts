/* The address policy lives in @app/shared so the API's outbound requests use the same rules. */
export { createAddressPolicy, embeddedIPv4, type AddressPolicy } from "@app/shared";
