use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
// Arrival order is observable through Object.values() in the coordinator API.
// Replacing an existing report must keep its original position.
#[derive(Clone)]
pub(crate) struct OrderedMap<T>(Vec<(String, T)>);
impl<T> Default for OrderedMap<T> {
    fn default() -> Self {
        Self(Vec::new())
    }
}
impl<T> OrderedMap<T> {
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }
    pub(crate) fn insert(&mut self, key: String, value: T) {
        if let Some(entry) = self.0.iter_mut().find(|entry| entry.0 == key) {
            entry.1 = value;
        } else {
            self.0.push((key, value));
        }
    }
    pub(crate) fn remove(&mut self, key: &str) {
        self.0.retain(|entry| entry.0 != key);
    }
}
impl<'a, T> IntoIterator for &'a OrderedMap<T> {
    type Item = &'a (String, T);
    type IntoIter = std::slice::Iter<'a, (String, T)>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}
impl<T: Serialize> Serialize for OrderedMap<T> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Visitor<T> {
            type Value = OrderedMap<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an ordered report map")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                let mut keys = HashSet::new();
                while let Some((key, value)) = map.next_entry::<String, T>()? {
                    if !keys.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate report key"));
                    }
                    entries.push((key, value));
                }
                Ok(OrderedMap(entries))
            }
        }
        deserializer.deserialize_map(Visitor(std::marker::PhantomData))
    }
}
