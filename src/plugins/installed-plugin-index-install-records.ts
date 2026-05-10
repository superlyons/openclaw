import type { PluginInstallRecord } from "../config/types.plugins.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

function setInstallStringField<Key extends keyof Omit<InstalledPluginInstallRecordInfo, "source">>(
  target: InstalledPluginInstallRecordInfo,
  key: Key,
  value: PluginInstallRecord[Key],
): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (normalized) {
    target[key] = normalized as InstalledPluginInstallRecordInfo[Key];
  }
}

function normalizeInstallRecord(
  record: PluginInstallRecord | undefined,
): InstalledPluginInstallRecordInfo | undefined {
  if (!record) {
    return undefined;
  }
  const normalized: InstalledPluginInstallRecordInfo = {
    source: record.source,
  };
  setInstallStringField(normalized, "spec", record.spec);
  setInstallStringField(normalized, "sourcePath", record.sourcePath);
  setInstallStringField(normalized, "installPath", record.installPath);
  setInstallStringField(normalized, "version", record.version);
  setInstallStringField(normalized, "resolvedName", record.resolvedName);
  setInstallStringField(normalized, "resolvedVersion", record.resolvedVersion);
  setInstallStringField(normalized, "resolvedSpec", record.resolvedSpec);
  setInstallStringField(normalized, "integrity", record.integrity);
  setInstallStringField(normalized, "shasum", record.shasum);
  setInstallStringField(normalized, "resolvedAt", record.resolvedAt);
  setInstallStringField(normalized, "installedAt", record.installedAt);
  setInstallStringField(normalized, "clawhubUrl", record.clawhubUrl);
  setInstallStringField(normalized, "clawhubPackage", record.clawhubPackage);
  setInstallStringField(normalized, "clawhubFamily", record.clawhubFamily);
  setInstallStringField(normalized, "clawhubChannel", record.clawhubChannel);
  setInstallStringField(normalized, "marketplaceName", record.marketplaceName);
  setInstallStringField(normalized, "marketplaceSource", record.marketplaceSource);
  setInstallStringField(normalized, "marketplacePlugin", record.marketplacePlugin);
  return normalized;
}

/*lyc: 恢复安装记录, 必须设置source属性值, 深度拷贝并将类型转换为 PluginInstallRecord 类型
record 必须设置了 source  属性值, 否则返回undefined, 
对record进行深拷贝, 避免修改原始record
对深度拷贝的record进行 PluginInstallRecord 类型转换, 入参 record 为 InstalledPluginInstallRecordInfo 类型
*/
function restoreInstallRecord(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginInstallRecord | undefined {
  if (!record?.source) {
    return undefined;
  }
  return structuredClone(record) as PluginInstallRecord;
}

export function normalizeInstallRecordMap(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> {
  const normalized: Record<string, InstalledPluginInstallRecordInfo> = {};
  for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const installRecord = normalizeInstallRecord(record);
    if (installRecord) {
      normalized[pluginId] = installRecord;
    }
  }
  return normalized;
}

// lyc: 恢复安装记录映射(多个安装记录), 排序, 深拷贝, 类型转换为 PluginInstallRecord 类型
// lyc: 注意入参是Record<string, InstalledPluginInstallRecordInfo>类型, 返回值是Record<string, PluginInstallRecord>类型
function restoreInstallRecordMap(
  records: Readonly<Record<string, InstalledPluginInstallRecordInfo>> | undefined,
): Record<string, PluginInstallRecord> {
  const restored: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const installRecord = restoreInstallRecord(record);
    if (installRecord) {
      restored[pluginId] = installRecord;
    }
  }
  return restored;
}

// lyc: 从index 已安装插件索引(InstalledPluginIndex ~/.openclaw/plugins/installs.json文件)中提取 installRecords|plugins[].installRecord(PluginInstallRecord 插件安装记录)
// lyc: 从index.installRecords 或 index.plugins[].installRecord中提取安装记录
export function extractPluginInstallRecordsFromInstalledPluginIndex(
  index: InstalledPluginIndex | null | undefined,
): Record<string, PluginInstallRecord> {
  // lyc: index有installRecords属性, 则认为是已安装插件索引(InstalledPluginIndex), 对其深度拷贝并返回
  // lyc: installRecords类型为Record<string, InstalledPluginInstallRecordInfo>, 返回值是Record<string, PluginInstallRecord>类型
  if (index && Object.prototype.hasOwnProperty.call(index, "installRecords")) {
    return restoreInstallRecordMap(index.installRecords);
  }
  // lyc: index没有installRecords属性, 
  /* lyc: 对其plugins属性进行遍历, 提取安装记录
    plugins类型为 InstalledPluginIndexRecord[], 该类型有 installRecord?: InstalledPluginInstallRecordInfo 属性
    对plugins中每个插件 installRecord 属性进行深度拷贝并转换为 PluginInstallRecord 类型, 并存储到 records 中
  */
  const records: Record<string, PluginInstallRecord> = {};
  for (const plugin of index?.plugins ?? []) {
    const record = restoreInstallRecord(plugin.installRecord);
    if (record) {
      records[plugin.pluginId] = record;
    }
  }
  return records;
}
