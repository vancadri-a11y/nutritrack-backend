import Foundation

struct WidgetMeal: Codable, Equatable {
    var name: String
    var suggestion: String
    var hour: Int
    var minute: Int
}

struct WidgetSnapshot: Codable, Equatable {
    static let groupID = "group.com.example.NutriTrackAI"
    static let storageKey = "widget.snapshot.v4"
    var updatedAt: Date
    var enabled: Bool
    var accent: String
    var consumed: Double
    var calorieGoal: Double
    var steps: Double?
    var activeEnergy: Double?
    var healthUpdatedAt: Date?
    var workoutCount: Int
    var workoutMinutes: Int
    var mealCount: Int
    var meals: [WidgetMeal]

    static var empty: Self {
        Self(updatedAt: .distantPast, enabled: true, accent: "forest", consumed: 0, calorieGoal: 0,
             steps: nil, activeEnergy: nil, healthUpdatedAt: nil, workoutCount: 0, workoutMinutes: 0, mealCount: 0, meals: [])
    }
    func forDate(_ date: Date, calendar: Calendar = .current) -> Self {
        var value = self
        if !calendar.isDate(updatedAt, inSameDayAs: date) {
            value.consumed = 0; value.mealCount = 0; value.workoutCount = 0; value.workoutMinutes = 0
            value.steps = nil; value.activeEnergy = nil; value.healthUpdatedAt = nil
        }
        return value
    }
    func nextMeal(at date: Date, calendar: Calendar = .current) -> (WidgetMeal, Date)? {
        meals.compactMap { meal -> (WidgetMeal, Date)? in
            guard let next = calendar.nextDate(after: date.addingTimeInterval(-1), matching: DateComponents(hour: meal.hour, minute: meal.minute), matchingPolicy: .nextTime) else { return nil }
            return (meal, next)
        }.min { $0.1 < $1.1 }
    }
    static func load(defaults: UserDefaults? = UserDefaults(suiteName: groupID)) -> Self {
        guard let data = defaults?.data(forKey: storageKey), let value = try? JSONDecoder().decode(Self.self, from: data) else { return .empty }
        return value
    }
    func save(defaults: UserDefaults? = UserDefaults(suiteName: Self.groupID)) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults?.set(data, forKey: Self.storageKey)
    }
}
