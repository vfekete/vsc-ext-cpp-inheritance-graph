#pragma once
// Many plain data types without any inheritance: exercises "standalone class" grouping.
#include <cstdint>
#include <string>
#include <vector>

namespace data::records {

struct Customer {
    double field0{};
    std::uint64_t field1{};
    int field2{};
};

struct Invoice {
    float field0{};
};

struct InvoiceLine {
    int field0{};
    bool field1{};
    int field2{};
};

struct Address {
    std::uint64_t field0{};
};

struct Payment {
    float field0{};
    bool field1{};
    float field2{};
    std::uint64_t field3{};
};

struct Refund {
    float field0{};
};

struct Shipment {
    int field0{};
    std::uint64_t field1{};
};

struct Parcel {
    bool field0{};
};

struct Carrier {
    double field0{};
};

struct TaxRate {
    std::uint64_t field0{};
    double field1{};
    float field2{};
};

struct Currency {
    double field0{};
    float field1{};
    bool field2{};
};

struct Discount {
    float field0{};
    float field1{};
    int field2{};
};

struct Voucher {
    std::vector<int> field0{};
    std::uint64_t field1{};
};

struct LoyaltyCard {
    std::vector<int> field0{};
    std::vector<int> field1{};
    std::string field2{};
};

struct Warehouse {
    bool field0{};
    double field1{};
    bool field2{};
};

struct StockItem {
    unsigned field0{};
};

struct Supplier {
    std::string field0{};
    std::vector<int> field1{};
    unsigned field2{};
    float field3{};
};

struct PurchaseOrder {
    std::uint64_t field0{};
};

struct Receipt {
    std::string field0{};
    double field1{};
};

struct AuditEntry {
    std::uint64_t field0{};
    int field1{};
    float field2{};
    std::string field3{};
};

} // namespace data::records

namespace data::config {

struct WindowConfig {
    std::string field0{};
    std::vector<int> field1{};
    std::vector<int> field2{};
};

struct AudioConfig {
    float field0{};
};

struct InputBinding {
    std::vector<int> field0{};
    float field1{};
    int field2{};
};

struct KeyMap {
    std::vector<int> field0{};
    unsigned field1{};
    std::uint64_t field2{};
};

struct GraphicsPreset {
    int field0{};
    std::vector<int> field1{};
    std::string field2{};
};

struct NetworkConfig {
    float field0{};
    std::vector<int> field1{};
};

struct ProxySettings {
    bool field0{};
};

struct LogConfig {
    double field0{};
    bool field1{};
    std::uint64_t field2{};
};

struct PathConfig {
    std::vector<int> field0{};
    float field1{};
    double field2{};
    std::vector<int> field3{};
};

struct LocaleConfig {
    unsigned field0{};
    double field1{};
    std::uint64_t field2{};
    unsigned field3{};
};

struct ThemeColors {
    std::string field0{};
    std::uint64_t field1{};
    bool field2{};
    double field3{};
};

struct FontSpec {
    double field0{};
};

} // namespace data::config

namespace data::math {

struct Vec2 {
    bool field0{};
    bool field1{};
};

struct Vec3 {
    std::vector<int> field0{};
};

struct Vec4 {
    unsigned field0{};
    unsigned field1{};
};

struct Quat {
    double field0{};
};

struct Mat3 {
    std::string field0{};
    std::string field1{};
    double field2{};
    int field3{};
};

struct Mat4 {
    std::uint64_t field0{};
    std::uint64_t field1{};
    std::uint64_t field2{};
    std::uint64_t field3{};
};

struct Aabb {
    std::vector<int> field0{};
};

struct Sphere {
    int field0{};
    bool field1{};
    float field2{};
    bool field3{};
};

struct Plane {
    double field0{};
    float field1{};
    std::string field2{};
    int field3{};
};

struct Ray {
    int field0{};
};

struct Frustum {
    float field0{};
    std::string field1{};
};

struct Rect {
    float field0{};
};

struct Color {
    std::uint64_t field0{};
    double field1{};
};

} // namespace data::math

namespace data::net {

struct PacketHeader {
    std::string field0{};
    std::string field1{};
    std::vector<int> field2{};
};

struct Endpoint {
    float field0{};
};

struct SessionInfo {
    std::vector<int> field0{};
    std::vector<int> field1{};
    std::vector<int> field2{};
    unsigned field3{};
};

struct PeerStats {
    double field0{};
};

} // namespace data::net
